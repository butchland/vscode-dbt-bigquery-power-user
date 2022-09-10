import { readFileSync, statSync } from "fs";
import { parse } from "yaml";
import * as path from "path";
import {
  SourceFileWatchers,
  SourceFileWatchersFactory,
} from "./modules/sourceFileWatchers";
import { TargetWatchersFactory } from "./modules/targetWatchers";
import { DBTProjectLog, DBTProjectLogFactory } from "./modules/dbtProjectLog";
import { setupWatcherHandler } from "../utils";
import {
  Disposable,
  EventEmitter,
  RelativePattern,
  Uri,
  workspace,
  Event,
  commands,
} from "vscode";
import { ProjectConfigChangedEvent } from "./event/projectConfigChangedEvent";
import { DBTProjectContainer } from "./dbtProjectContainer";
import {
  DBTCommandFactory,
  RunModelParams,
} from "../dbt_client/dbtCommandFactory";
import { ManifestCacheChangedEvent } from "./event/manifestCacheChangedEvent";
import { DBTTerminal } from "../dbt_client/dbtTerminal";
import { syncBuiltinESMExports } from "module";

// import {
//   runAsQueryText,
// } from "../bigquery";
export class DBTProject implements Disposable {
  static DBT_PROJECT_FILE = "dbt_project.yml";
  static DBT_MODULES = ["dbt_modules", "dbt_packages"];
  static MANIFEST_FILE = "manifest.json";
  static RUN_RESULTS_FILE = "run_results.json";
  static TARGET_PATH_VAR = "target-path";
  static SOURCE_PATHS_VAR = ["source-paths", "model-paths"];

  static RESOURCE_TYPE_MODEL = "model";
  static RESOURCE_TYPE_SOURCE = "source";
  static RESOURCE_TYPE_SEED = "seed";
  static RESOURCE_TYPE_SNAPSHOT = "snapshot";

  readonly projectRoot: Uri;
  private projectName: string | undefined;
  private targetPath: string | undefined;
  private sourcePaths: string[] | undefined;

  private _onProjectConfigChanged = new EventEmitter<ProjectConfigChangedEvent>();
  public onProjectConfigChanged = this._onProjectConfigChanged.event;
  private sourceFileWatchers: SourceFileWatchers;
  public onSourceFileChanged: Event<void>;
  private dbtProjectLog: DBTProjectLog;
  private disposables: Disposable[] = [this._onProjectConfigChanged];

  constructor(
    private dbtProjectContainer: DBTProjectContainer,
    private sourceFileWatchersFactory: SourceFileWatchersFactory,
    private dbtProjectLogFactory: DBTProjectLogFactory,
    private targetWatchersFactory: TargetWatchersFactory,
    private dbtCommandFactory: DBTCommandFactory,
    private terminal: DBTTerminal,
    path: Uri,
    _onManifestChanged: EventEmitter<ManifestCacheChangedEvent>
  ) {
    this.projectRoot = path;

    const dbtProjectConfigWatcher = workspace.createFileSystemWatcher(
      new RelativePattern(path, DBTProject.DBT_PROJECT_FILE)
    );

    setupWatcherHandler(dbtProjectConfigWatcher, () => this.tryRefresh());

    this.sourceFileWatchers = this.sourceFileWatchersFactory.createSourceFileWatchers(
      this.onProjectConfigChanged
    );
    this.onSourceFileChanged = this.sourceFileWatchers.onSourceFileChanged;

    this.dbtProjectLog = this.dbtProjectLogFactory.createDBTProjectLog(
      this.onProjectConfigChanged
    );

    this.disposables.push(
      this.targetWatchersFactory.createTargetWatchers(
        _onManifestChanged,
        this.onProjectConfigChanged
      ),
      dbtProjectConfigWatcher,
      this.onSourceFileChanged(() => this.listModels()),
      this.sourceFileWatchers,
      this.dbtProjectLog
    );
  }
  public getTargetPath(): string | undefined {
    return this.targetPath;
  }
  async tryRefresh() {
    try {
      await this.refresh();
    } catch (error) {
      console.log("An error occurred while trying to refresh the project configuration", error);
      this.terminal.log(`An error occurred while trying to refresh the project configuration: ${error}`);
    }
  }

  findPackageName(uri: Uri): string | undefined {
    const documentPath = uri.path;
    const pathSegments = documentPath
      .replace(new RegExp(this.projectRoot.path + "/", "g"), "")
      .split("/");

    const insidePackage =
      pathSegments.length > 1 && DBTProject.DBT_MODULES.includes(pathSegments[0]);

    if (insidePackage) {
      return pathSegments[1];
    }
    return undefined;
  }

  contains(uri: Uri) {
    return uri.fsPath.startsWith(this.projectRoot.fsPath + path.sep);
  }

  listModels() {
    this.dbtProjectContainer.listModels(this.projectRoot);
  }

  runModel(runModelParams: RunModelParams) {
    const runModelCommand = this.dbtCommandFactory.createRunModelCommand(
      this.projectRoot,
      runModelParams
    );
    this.dbtProjectContainer.addCommandToQueue(runModelCommand);
  }

  compileModel(runModelParams: RunModelParams) {
    console.log(`compileMode.runModelParams.modelName: ${runModelParams.modelName} `);
    console.log(`compileMode.runModelParams.plusOperatorLeft: ${runModelParams.plusOperatorLeft} `);
    console.log(`compileMode.runModelParams.plusOperatorRight: ${runModelParams.plusOperatorRight} `);

    const runModelCommand = this.dbtCommandFactory.createCompileModelCommand(
      this.projectRoot,
      runModelParams
    );
    this.dbtProjectContainer.addCommandToQueue(runModelCommand);
  }

  showCompiledSql(modelPath: Uri) {
    this.findModelInTargetfolder(modelPath, "compiled");
  }


  showRunSQL(modelPath: Uri) {
    this.findModelInTargetfolder(modelPath, "run");
  }

  dispose() {
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private readAndParseProjectConfig() {
    const dbtProjectYamlFile = readFileSync(
      path.join(this.projectRoot.fsPath, DBTProject.DBT_PROJECT_FILE),
      "utf8"
    );
    return parse(dbtProjectYamlFile, { uniqueKeys: false}) as any;
  }
  public isCompiled(docUri: Uri): boolean {
    if (this.targetPath) {
      return docUri.fsPath.startsWith(this.targetPath);
    }
    return false;
  }
  private async createCompileModel(relativePath: string) {
    const runModelParams: RunModelParams = {
      plusOperatorLeft: "",
      modelName: relativePath,
      plusOperatorRight: ""

    };
    const runModelCommand = this.dbtCommandFactory.createCompileModelCommand(
      this.projectRoot,
      runModelParams
    );
    console.log(`executing immediately Command ${runModelCommand.commandAsString} `);
    await this.dbtProjectContainer.executeCommandImmediately(runModelCommand);

  }

  public async getCompiledSQLText(modelPath: Uri): Promise<string | undefined> {
    let remaining = path.relative(this.projectRoot.path, modelPath.path);
    remaining = remaining.split(path.sep).join('/');
    const pattern = `${this.targetPath}/compiled/${this.projectName}/${remaining}`;
    //const modelName = path.basename(modelPath.fsPath, ".sql");

    // console.log(`findModelInTargetfolder: looking for ${pattern}`);
    let targetModels = await workspace.findFiles(
      new RelativePattern(
        this.projectRoot,
        pattern
      )
    );
    if (targetModels.length > 0) {
     
      const orig_file = modelPath.fsPath;
      const orig_file_stats = statSync(orig_file);
      const orig_file_mtime = orig_file_stats.mtime;

      const targetModel0 = targetModels[0];
      // console.log(`findModelInTargetfolder: ${targetModel0}`);
      // const target_path = targetModel0.fsPath;
      const target_path = targetModel0.fsPath;
      console.log(`previewSQLInTargetfolder: ${target_path}`);
      const target_path_stats = statSync(target_path);
      const target_path_mtime = target_path_stats.mtime;
      console.log(`target_path_mtime: ${target_path_mtime}`);
      if (target_path_mtime < orig_file_mtime) {
        // trigger compile
        await this.createCompileModel(remaining);
      }

      const buffer = readFileSync(targetModel0.fsPath);
      return buffer.toString();
    } else {
      // target not yet compiled
      await this.createCompileModel(remaining);
      // try after compilation
      // loop on this and await
      const snooze = (ms:number) => new Promise(resolve => setTimeout(resolve, ms));
      const sleep = async() => {
        await snooze(1000); // snooze 1 sec
      };
      const MAX_TRIES = 100;
      let t = 0;
      while (t < MAX_TRIES) {
        targetModels = await workspace.findFiles(
          new RelativePattern(
            this.projectRoot,
            pattern
          )
        );
        if (targetModels.length === 0) {
          sleep();
          t += 1;  
        } else {
          t = MAX_TRIES;
        }
       

      }
      if (targetModels.length === 0) {
        throw new Error("Current model not found!");
      }
      const targetModel0 = targetModels[0];
      // console.log(`findModelInTargetfolder: ${targetModel0}`);
      const target_path = targetModel0.fsPath;
      console.log(`previewSQLInTargetfolder: ${target_path}`);
      const target_path_stats = statSync(target_path);
      const target_path_mtime = target_path_stats.mtime;
      console.log(`target_path_mtime: ${target_path_mtime}`);
      const buffer = readFileSync(targetModel0.fsPath);
      return buffer.toString();

    }


  }
  private async findModelInTargetfolder(modelPath: Uri, type: string) {
    let remaining = path.relative(this.projectRoot.path, modelPath.path);
    remaining = remaining.split(path.sep).join('/');
    const pattern = `${this.targetPath}/${type}/${this.projectName}/${remaining}`;
    // console.log(`findModelInTargetfolder: looking for ${pattern}`);
    const targetModels = await workspace.findFiles(
      new RelativePattern(
        this.projectRoot,
        pattern
      )
    );
    if (targetModels.length > 0) {
      const targetModel0 = targetModels[0];
      // console.log(`findModelInTargetfolder: ${targetModel0}`);
      commands.executeCommand("vscode.open", targetModel0, {
        preview: false,
      });
    }
  }

  private findSourcePaths(projectConfig: any): string[] {
    return DBTProject.SOURCE_PATHS_VAR.reduce((prev: string[], current: string) => {
      if (projectConfig[current] !== undefined) {
        return projectConfig[current] as string[];
      } else {
        return prev;
      }
    }, ["models"]);
  }

  private findTargetPath(projectConfig: any): string {
    if (projectConfig[DBTProject.TARGET_PATH_VAR] !== undefined) {
      return projectConfig[DBTProject.TARGET_PATH_VAR] as string;
    }
    return "target";
  }

  private async refresh() {
    const projectConfig = this.readAndParseProjectConfig();
    this.projectName = projectConfig.name;
    this.targetPath = this.findTargetPath(projectConfig);
    this.sourcePaths = this.findSourcePaths(projectConfig);

    const event = new ProjectConfigChangedEvent(
      this.projectRoot,
      this.projectName as string,
      this.targetPath,
      this.sourcePaths
    );
    this._onProjectConfigChanged.fire(event);
  }
}
