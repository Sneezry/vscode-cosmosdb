/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as cp from 'child_process';
import * as os from 'os';
import * as vscode from "vscode";
import { EventEmitter } from 'vscode';
import { ext } from '../extensionVariables';
import { IDisposable, toDisposable } from '../utils/vscodeUtils';

type CommandResult = {
	stringResult?: string;
	exitCode?: number;
	code?: string;
	message?: string;
};

export class Shell {

	private executionId: number = 0;
	private disposables: IDisposable[] = [];

	private onResult: EventEmitter<CommandResult> = new EventEmitter<CommandResult>();

	public static create(execPath: string, connectionString: string, isEmulator: boolean): Promise<Shell> {
		return new Promise((resolve, reject) => {
			try {
				let args = ['--quiet', connectionString];
				if (isEmulator) {
					// Without this the connection will fail due to the self-signed DocDB certificate
					args.push("--ssl");
					args.push("--sslAllowInvalidCertificates");
				}
				const shellProcess = cp.spawn(execPath, args);
				return resolve(new Shell(execPath, shellProcess));
			} catch (error) {
				reject(`Error while creating mongo shell with path '${execPath}': ${error}`);
			}
		});
	}

	constructor(private execPath: string, private mongoShell: cp.ChildProcess) {
		this.initialize();
	}

	private fireOnResult(result: CommandResult): void {
		this.onResult.fire(result);
	}

	private initialize() {
		const once = (ee: NodeJS.EventEmitter, name: string, fn: Function) => {
			ee.once(name, fn);
			this.disposables.push(toDisposable(() => ee.removeListener(name, fn)));
		};

		const on = (ee: NodeJS.EventEmitter, name: string, fn: Function) => {
			ee.on(name, fn);
			this.disposables.push(toDisposable(() => ee.removeListener(name, fn)));
		};

		// tslint:disable-next-line:no-any
		once(this.mongoShell, 'error', (error: any) => {
			this.fireOnResult(error);
		});
		once(this.mongoShell, 'exit', (exitCode: number) => {
			this.fireOnResult({ stringResult: "", exitCode });
		});

		let buffers: string[] = [];
		on(this.mongoShell.stdout, 'data', (b: Buffer) => {
			let data: string = b.toString();
			const delimiter = `${this.executionId}${os.EOL}`;
			if (data.endsWith(delimiter)) {
				const result: string = buffers.join('') + data.substring(0, data.length - delimiter.length);
				buffers = [];
				this.fireOnResult({ stringResult: result });
			} else {
				buffers.push(data); // asdf was buffer
			}
		});

		on(this.mongoShell.stderr, 'data', (stderrOutput: Buffer) => {
			this.fireOnResult(new Error(stderrOutput.toString()));
		});
		once(this.mongoShell.stderr, 'close', () => {
			// Do nothing
		});
	}

	async useDatabase(database: string): Promise<string> {
		return this.exec(`use ${database}`);
	}

	async exec(script: string): Promise<string> {
		script = this.convertToSingleLine(script);
		const executionId = this._generateExecutionSequenceId();
		// tslint:disable-next-line:no-any
		let writeError: any;

		try {
			this.mongoShell.stdin.write(script, 'utf8');
			this.mongoShell.stdin.write(os.EOL);
			this.mongoShell.stdin.write(executionId, 'utf8');
			this.mongoShell.stdin.write(os.EOL);
		} catch (error) {
			// Generally if writing to the process' stdin fails it has already exited
			// with an error, and we will get notification via its stdout. So hold on to
			// this and only return it if we don't see any other notifications after timeout.
			writeError = error;
		}

		return await new Promise<string>((resolve, reject) => {
			let executed = false;
			const timeout: number = 1000 * vscode.workspace.getConfiguration().get<number>(ext.settingsKeys.mongoShellTimeout);
			const timeoutHandler = setTimeout(
				() => {
					if (!executed) {
						if (writeError) {
							reject(writeError);
						} else {
							reject(`Timed out executing MongoDB command "${script}"`);
						}
					}
				},
				timeout);

			// Handle results
			const disposable = this.onResult.event((result: CommandResult) => {
				// We will only process the first time onResult is fired
				disposable.dispose();

				if (result.stringResult) {
					let lines = result.stringResult.split(os.EOL).filter(line => !!line && line !== 'Type "it" for more');
					lines = lines[lines.length - 1] === 'Type "it" for more' ? lines.splice(lines.length - 1, 1) : lines;
					executed = true;
					resolve(lines.join(os.EOL));
				} else {
					if (result.code === 'ENOENT') {
						result.message = `This functionality requires the Mongo DB shell, but we could not find it. Please make sure it is on your path or you have set the '${ext.settingsKeys.mongoShellPath}' VS Code setting to point to the Mongo shell executable file (not folder). Attempted command: "${this.execPath}"`;
					} else if (result.exitCode) {
						result.message = result.message || `Mongo shell exited with code ${result.exitCode}`;
					}

					result.message = result.message || "An error occurred executing the Mongo shell command";

					reject(result);
				}

				if (timeoutHandler) {
					clearTimeout(timeoutHandler);
				}
			});
		});
	}

	private convertToSingleLine(script: string): string {
		return script.split(os.EOL)
			.map(line => line.trim())
			.join('')
			.trim();

	}

	private _generateExecutionSequenceId(): string {
		return `${++this.executionId}`;
	}
}
