import * as vscode from "vscode";
import { BigQuery, Job, BigQueryOptions, QueryRowsResponse } from "@google-cloud/bigquery";
import * as flatten from "flat";
import { DBTProjectContainer } from "./manifest/dbtProjectContainer";
interface QueryResult {
  status: "success";
  sql?: string;
  info: { [s: string]: any };
  table: TableResult;
  json: string;
  detail: string;
  startIndex?: number;
  totalRecords: number;
  maxResults: number;
  hasNext: boolean;
  hasPrev: boolean;
  limitEnabled: boolean;
  limitCount: number;
}

interface QueryResultError {
  status: "error";
  errorMessage: string;
}

interface TableResult {
  headers: string[];
  rows: any[];
}

const hashCode = (s:string):string => {
    let hash = 0;
    for (let i = 0; i < s.length; i++) {
      const chr   = s.charCodeAt(i);
      hash  = ((hash << 5) - hash) + chr;
      hash |= 0; // Convert to 32bit integer
    }
    return 'hash' + Math.abs(hash).toString();
};
const DEFAULT_ITEMS_PER_PAGE = 50;
const DEFAULT_LIMIT_COUNT = 1000;
export class BigQueryRunner {
  config: vscode.WorkspaceConfiguration;
  client: BigQuery;
  job: Job | null = null;
  editor: vscode.TextEditor;
  startIndex: number;
  items_per_page: number = DEFAULT_ITEMS_PER_PAGE;
  limitEnabled: boolean | undefined;
  limitCount: number | undefined;
  totalRecords: number;
  dbtProjectContainer: DBTProjectContainer | undefined;
  nextToken: any;
  constructor(config: vscode.WorkspaceConfiguration, editor: vscode.TextEditor) {
    this.config = config;
    this.editor = editor;
    this.startIndex = 0;
    this.nextToken = undefined;
    const items_per_page = this.config?.get("itemsPerPage", DEFAULT_ITEMS_PER_PAGE);
    if (items_per_page) {
      this.items_per_page = parseInt(items_per_page.toString());
    }
    this.totalRecords = 0;
    let options: BigQueryOptions = {
      keyFilename: this.config?.get("keyFilename"),
      projectId: this.config?.get("projectId"),
    };
    this.limitEnabled = this.config?.get("limitEnabled", false);
    this.limitCount = this.config?.get("limitCount", DEFAULT_LIMIT_COUNT);
    if (this.limitEnabled === undefined) {
      this.limitEnabled = false;
    }
    if (this.limitCount === undefined) {
      this.limitCount = DEFAULT_LIMIT_COUNT;
    }

    this.client = new BigQuery(options);

  }
  setDbtProjectContainer(dbtProjectContainer: DBTProjectContainer) {
    this.dbtProjectContainer = dbtProjectContainer;
  }
  findTargetPath(docUri: vscode.Uri): string {
    if (!this.dbtProjectContainer) {
      throw new Error("dbtProjectContainer not initialized for runner!");
    }
    const dbtProject = this.dbtProjectContainer.findDBTProject(docUri);
    if (!dbtProject) {
      throw new Error(`couldn't find DBT Project for ${docUri}`);
    }
    const targetPath = dbtProject.getTargetPath();
    if (!targetPath) {
      throw new Error(`couldn't find targetPath for ${docUri}`);
    }
    return targetPath;
  }
  findProjectRoot(docUri: vscode.Uri): vscode.Uri {
    if (!this.dbtProjectContainer) {
      throw new Error("dbtProjectContainer not initialized for runner!");
    }
    const dbtProject = this.dbtProjectContainer.findDBTProject(docUri);
    if (!dbtProject) {
      throw new Error(`couldn't find DBT Project for ${docUri}`);
    }
    return dbtProject.projectRoot;
  }
  setConfig(config: vscode.WorkspaceConfiguration) {
    this.config = config;
  }


  /**
   * @param queryText
   * @param isDryRun Defaults to False.
   */
  private async query(queryText: string, isDryRun?: boolean): Promise<QueryResult> {
    let data;
    console.log(`queryrunner run query: queryText: ${queryText}`);
    try {
      data = await this.client.createQueryJob({
        query: queryText,
        dryRun: !!isDryRun,
        jobTimeoutMs: this.config?.get('timeoutMs')
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to query BigQuery: ${err}`);
      throw err;
    }
    this.job = data[0];

    if (!this.job) {
      throw new Error("No job was found.");
    }

    vscode.window.showInformationMessage(`BigQuery job ID: ${this.job.metadata.id}`);
    console.log(`Job : ${JSON.stringify(this.job)}`);
    let result: QueryRowsResponse;
    // reset index to 0
    this.startIndex = 0;
    console.log('get query results startIndex', this.startIndex);
    try {
      result = await this.job.getQueryResults({
        autoPaginate: true, // TODO
        maxResults: this.items_per_page,
        startIndex: this.startIndex.toString(),
        timeoutMs: this.config?.get('timeoutMs')
      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to query BigQuery: ${err}`);
      throw err;
    }
    // console.log(`result: ${JSON.stringify(result)}`);
    try {
      console.log('get query results before processResults startIndex', this.startIndex);
      console.log('query result length', result.length);

      return await this.processResults(result[0], result[1], result[2]);

    } catch (err) {
      vscode.window.showErrorMessage(`Failed to get results: ${err}`);
      throw err;
    }
  }

  private makeTable(rows: Array<any>): TableResult {
    const headers: string[] = [];
    Object.keys(flatten(rows[0], { safe: true })).forEach(name => headers.push(name));

    let table: any[] = [];

    rows.forEach((val, idx) => {
      // Flatten each row, and for each header (name), insert the matching
      // object property (v[name])
      let v: { [s: string]: any } = flatten(val, { safe: true });
      let tableRow: any[] = [];
      headers.forEach((name, col) => {
        tableRow.push(v[name]);
      });
      table.push(tableRow);
    });

    return {
      headers,
      rows: table
    };
  }

  private async processResults(rows: Array<any>, nextToken: any, resultsResponse: any): Promise<QueryResult> {
    if (!this.job) {
      throw new Error('No job was found.');
    }

    this.nextToken = nextToken;
    console.log(`nextToken: ${JSON.stringify(nextToken)}`);
    const metadata = (await this.job.getMetadata())[0];
    const startRowId = this.startIndex;
    const table = this.makeTable(rows);
    console.log('startRowID ', startRowId);

    // increment startIndex to continue 
    let start = this.startIndex;
    if (rows.length > 0) {
      let newstart = start + rows.length;
      this.startIndex = newstart;
    }
    console.log(`metadata.statistics: ${JSON.stringify(metadata.statistics)}`);
    // console.log(`resultsResponse: ${JSON.stringify(resultsResponse)}`);
    this.totalRecords = resultsResponse.totalRows;
    return {
      status: "success",
      info: {
        projectId: metadata.jobReference.projectId,
        jobId: metadata.id,
        location: this.job.location,
        jobLink: metadata.selfLink,
        creationTime: metadata.statistics.creationTime,
        startTime: metadata.statistics.startTime,
        endTime: metadata.statistics.endTime,
        userEmail: metadata.user_email,
        totalBytesProcessed: metadata.statistics.totalBytesProcessed,
        status: metadata.status.state,
      },
      table: table,
      json: JSON.stringify(rows, null, "  "),
      detail: JSON.stringify(metadata.statistics, null, "  "),
      startIndex: startRowId,
      totalRecords: resultsResponse.totalRows,
      maxResults: this.items_per_page,
      hasNext: !!this.nextToken,
      hasPrev: startRowId > 0,
      limitEnabled: this.limitEnabled?? false,
      limitCount: this.limitCount?? 0,
    };
  }
  public async getPrevPage(): Promise<QueryResult | QueryResultError> {
    if (!this.job) {
      vscode.window.showErrorMessage('Prev page invalid as no job has been started!');
      return {
        status: "error",
        errorMessage: 'Next page invalid as no job has been started!',
      };
    }
    if (this.startIndex === 0) {
      vscode.window.showErrorMessage('Prev page invalid');
      return {
        status: "error",
        errorMessage: 'Prev page invalid as no job has been started!',
      };
    }
    //
    const startIndex = this.startIndex;
    let newStartIndex = startIndex - 2 * this.items_per_page;
    if (newStartIndex < 0) {
      newStartIndex = 0;
    }
    this.startIndex = newStartIndex;
    return this.getNextPage();
  }
  public async getFirstPage(): Promise<QueryResult | QueryResultError> {
    if (!this.job) {
      vscode.window.showErrorMessage('Prev page invalid as no job has been started!');
      return {
        status: "error",
        errorMessage: 'Next page invalid as no job has been started!',
      };
    }
    //
    this.startIndex = 0;
    return this.getNextPage();
  }

  public async getLastPage(): Promise<QueryResult | QueryResultError> {
    if (!this.job) {
      vscode.window.showErrorMessage('Prev page invalid as no job has been started!');
      return {
        status: "error",
        errorMessage: 'Next page invalid as no job has been started!',
      };
    }
    //
    let lastIndex = this.totalRecords - this.items_per_page;
    if (lastIndex < 0) {
      lastIndex = 0;
    }
    this.startIndex = lastIndex;
    return this.getNextPage();
  }


  public async getNextPage(): Promise<QueryResult | QueryResultError> {
    if (!this.job) {
      vscode.window.showErrorMessage('Next page invalid as no job has been started!');
      return {
        status: "error",
        errorMessage: 'Next page invalid as no job has been started!',
      };
    }
    let result;
    try {
      console.log('next page get query results startIndex', this.startIndex);
      result = await this.job.getQueryResults({
        autoPaginate: true,
        maxResults: this.items_per_page,
        startIndex: this.startIndex.toString(),

      });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to query BigQuery: ${err}`);
      throw err;
    }
    console.log(`next result: ${JSON.stringify(result)}`);
    try {
      console.log('next query before processResults startIndex', this.startIndex);
      console.log('next query result length', result.length);
      return await this.processResults(result[0], result[1], result[2]);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to get results: ${err}`);
      throw err;
    }
  }
  private async getFinalQueryText() {
      console.log(`BigQueryRunner.runAsQuery`);
      const queryText = await this.getQueryText();
      console.log(`BigQueryRunner.runAsQuery.queryText:  ${queryText}`);
      let finalQueryText = queryText;
      if (this.limitEnabled) {
        const random_ctename = hashCode(queryText);
        finalQueryText = `WITH ${random_ctename} AS (\n${queryText}\n)\nSELECT * \nFROM ${random_ctename}\nLIMIT ${this.limitCount}`;
      }
      console.log(`final queryrunner run query: final queryText: ${finalQueryText}`);
      return finalQueryText;

  }
  public async runAsQuery(): Promise<QueryResult | QueryResultError> {
    try {
      const finalQueryText = await this.getFinalQueryText();
      let queryResult = await this.query(finalQueryText);
      //console.log(`BigQueryRunner.runAsQuery.queryResult: ${queryResult}`);
      queryResult.sql = finalQueryText;
      return queryResult;
    } catch (err) {
      console.log(`BiqQueryRunner.runAsQuery.catcherr: ${err}`);
      vscode.window.showErrorMessage(`${err}`);
      return {
        status: "error",
        errorMessage: (err instanceof Error) ? err.message : '',
      };
    }
  }

  public async cancelQuery(): Promise<any> {
    if (!this.job) {
      vscode.window.showErrorMessage('No job was found.');
      return;
    }

    const result = await this.job.cancel();
    return result;
  }
  private isCompiled(docUri: vscode.Uri): boolean {
    if (!this.dbtProjectContainer) {
      throw new Error("dbtProjectContainer not initialized for runner!");
    }
    const dbtProject = this.dbtProjectContainer.findDBTProject(docUri);
    if (!dbtProject) {
      // if not part of dbt project, assume compiled is true
      return true;
    }
    return dbtProject.isCompiled(docUri);
  }
  private async findCompiledSQLText(docUri: vscode.Uri): Promise<string | undefined> {
    if (!this.dbtProjectContainer) {
      throw new Error("dbtProjectContainer not initialized for runner!");
    }
    const dbtProject = this.dbtProjectContainer.findDBTProject(docUri);
    if (!dbtProject) {
      // if not part of dbt project, assume compiled is true
      throw new Error('something went wrong with file lookup');
    }
    return dbtProject.getCompiledSQLText(docUri);
  }
  public async getQueryText(): Promise<string> {
    if (!this.editor) {
      throw new Error("No active editor window was found");
    }
    console.log(`queryRunner.getQueryText.docURI.fsPath: ${this.editor.document.uri.fsPath}`);
    const compiled = this.isCompiled(this.editor.document.uri);
    let text: string | undefined;
    if (compiled) {
      text = this.editor.document.getText().trim();
    } else {
      const docUri = this.editor.document.uri;
      if (this.editor.document.isDirty) {
        const saved = await this.editor.document.save();
        if (!saved) {
          throw new Error("Couldn't save current document");
        }
      }
      text = await this.findCompiledSQLText(docUri);
      if (!text) {
        throw new Error("No compiled SQL found!");
      }
    }

    if (!text) {
      throw new Error("The editor window is empty");
    }
    return text;
  }



}

