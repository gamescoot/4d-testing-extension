import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mapFunctionLineToSourceLine, mapProjectMethodLineToSourceLine } from './parser';

const LOG_PATH = path.join(os.tmpdir(), '4d-testing-extension.log');
function dbg(msg: string) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
        fs.appendFileSync(LOG_PATH, line);
    } catch {
        // ignore logging failures
    }
}

// 4D sometimes emits JSON with raw control characters inside string values
// (e.g. literal \n in an error message). JSON.parse rejects that; this walks
// the input and escapes any unescaped control chars while inside a string.
function escapeControlCharsInJsonStrings(s: string): string {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (escaped) {
            out += c;
            escaped = false;
            continue;
        }
        if (c === '\\') {
            out += c;
            escaped = true;
            continue;
        }
        if (c === '"') {
            inString = !inString;
            out += c;
            continue;
        }
        if (inString) {
            const code = c.charCodeAt(0);
            if (code === 0x0A) out += '\\n';
            else if (code === 0x0D) out += '\\r';
            else if (code === 0x09) out += '\\t';
            else if (code === 0x08) out += '\\b';
            else if (code === 0x0C) out += '\\f';
            else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
            else out += c;
        } else {
            out += c;
        }
    }
    return out;
}

export async function startTestRun(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken
) {
    try { fs.writeFileSync(LOG_PATH, ''); } catch { /* ignore */ }
    dbg(`startTestRun (include=${request.include?.length ?? 'all'})`);

    const run = controller.createTestRun(request);

    const queue: vscode.TestItem[] = [];
    const isRunningAllTests = !request.include;

    if (request.include) {
        for (const test of request.include) {
            // Climb up until the parent is a direct child of the root (file)
            let current: vscode.TestItem = test;
            while (current.parent && current.parent.parent) {
                current = current.parent;
            }
            queue.push(current);
        }
    } else {
        controller.items.forEach(test => queue.push(test));
    }

    const workspaceFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    // Collect class + function combos to run
    const testTargets: { suite: string; func: string; item: vscode.TestItem }[] = [];

    while (queue.length > 0 && !token.isCancellationRequested) {
        const test = queue.pop()!;

        // If this is a test function (starts with test_), track it
        if (test.label?.startsWith('test_')) {
            run.started(test);

            const fileName = test.uri?.path.split('/').pop() ?? '';
            const suite = fileName.replace(/\.4dm$/, '');
            const func = test.label;

            testTargets.push({ suite, func, item: test });
        }
        if (token.isCancellationRequested) {
            dbg('cancellation requested during queue traversal');
        }

        // Recursively process children
        test.children.forEach(child => {
            queue.push(child);
        });
    }

    if (testTargets.length > 0) {
        // Deduplicate by suite+func
        const uniqueTargets = Array.from(
            new Set(testTargets.map(t => `${t.suite}.${t.func}`))
        );

        // Have the testing component write JSON to a file so we don't depend
        // on stdout (which 4D can truncate on large runs). Use a workspace-
        // relative path since the testing component resolves outputPath
        // against the project root, not the OS.
        const relOutputPath = `.4d-testing-extension/results-${Date.now()}.json`;
        const absOutputPath = path.join(workspaceFolder, relOutputPath);
        try {
            fs.mkdirSync(path.dirname(absOutputPath), { recursive: true });
        } catch { /* ignore */ }
        const cmdArgs = ['test', 'format=json', `outputPath=${relOutputPath}`];

        const tool4dPath = vscode.workspace.getConfiguration('4d-testing-extension').get<string>('tool4dPath');
        if (tool4dPath) {
            cmdArgs.push(`TOOL4D=${tool4dPath}`);
        }

        // If profile has tag, include tag param
        const profileTag = (request.profile?.label?.match(/Run '(.+)' tests/) || [])[1];
        if (profileTag) {
            cmdArgs.push(`tag=${profileTag}`);
        } else if (!isRunningAllTests) {
            // Only specify tests if not running all tests
            cmdArgs.push(`test=${uniqueTargets.join(',')}`);
        }

        dbg(`testTargets count=${testTargets.length}`);
        if (testTargets.length > 0) {
            dbg(`testTargets first 5: ${testTargets.slice(0, 5).map(t => `${t.suite}.${t.func}`).join(', ')}`);
        }
        dbg(`spawn: make ${cmdArgs.join(' ')} (cwd=${workspaceFolder})`);
        run.appendOutput(`Spawning: make ${cmdArgs.join(' ')}\n`);

        await new Promise<void>(resolve => {
            const makeProcess = spawn('make', cmdArgs, { cwd: workspaceFolder });

            // Collect raw buffers and decode once at the end so multi-byte
            // characters don't get split across chunk boundaries.
            const chunks: Buffer[] = [];
            let stdoutBytes = 0;
            let stdoutEnded = false;
            makeProcess.stdout?.on('data', (data: Buffer) => {
                chunks.push(data);
                stdoutBytes += data.length;
            });
            makeProcess.stdout?.on('end', () => {
                stdoutEnded = true;
                dbg(`stdout end (${stdoutBytes} bytes received in ${chunks.length} chunks)`);
            });
            makeProcess.stdout?.on('error', (err) => {
                dbg(`stdout error: ${err?.message ?? err}`);
            });

            makeProcess.stderr?.on('data', (data: Buffer) => {
                run.appendOutput(data.toString());
            });

            makeProcess.on('close', async (code) => {
                dbg(`close fired (exit=${code}, stdoutEnded=${stdoutEnded}, bytes=${stdoutBytes})`);
                try {
                    // The testing component writes to outputPath relative to
                    // the project root. Resolve against the workspace.
                    const candidates = [
                        absOutputPath,
                        path.join(workspaceFolder, relOutputPath),
                    ];
                    const resolvedPath = candidates.find(p => fs.existsSync(p));
                    if (!resolvedPath) {
                        dbg(`results file not found at: ${candidates.join(' | ')}`);
                        run.appendOutput(`Could not find test results file\n`);
                        resolve();
                        return;
                    }

                    const stat = fs.statSync(resolvedPath);
                    dbg(`reading results from ${resolvedPath} (${stat.size} bytes)`);
                    let jsonStr = fs.readFileSync(resolvedPath, 'utf8');
                    if (jsonStr.charCodeAt(0) === 0xFEFF) {
                        jsonStr = jsonStr.slice(1);
                    }

                    let results: any;
                    try {
                        results = JSON.parse(jsonStr);
                    } catch (parseErr: any) {
                        dbg(`JSON.parse failed: ${parseErr?.message}`);
                        dbg('attempting sanitized retry...');
                        try {
                            results = JSON.parse(escapeControlCharsInJsonStrings(jsonStr));
                            dbg('sanitized parse succeeded');
                        } catch (retryErr: any) {
                            dbg(`sanitized parse also failed: ${retryErr?.message}`);
                            throw parseErr;
                        }
                    }

                    const resultCount = Array.isArray(results?.testResults) ? results.testResults.length : 0;
                    dbg(`parsed ${resultCount} test results`);

                    dbg(`starting handleResults (testTargets=${testTargets.length})`);
                    const startedAt = Date.now();
                    await handleResults(results, run, testTargets, controller);
                    dbg(`handleResults finished in ${Date.now() - startedAt}ms`);

                    try { fs.unlinkSync(resolvedPath); } catch { /* ignore */ }
                } catch (err: any) {
                    dbg(`error in close handler: ${err?.message ?? err}`);
                    dbg(`stack: ${err?.stack ?? '(no stack)'}`);
                    run.appendOutput(`Error parsing JSON: ${err?.message ?? err}\n`);
                }
                resolve();
            });
            makeProcess.on('error', (err) => {
                dbg(`makeProcess error: ${err?.message ?? err}`);
            });
        });
    }

    dbg('calling run.end()');
    run.end();
    dbg('run.end() returned');
}

async function fileHasAttributeLine(uri: vscode.Uri | undefined): Promise<boolean> {
    if (!uri) return false;
    try {
        const rawContent = await vscode.workspace.fs.readFile(uri);
        let content = new TextDecoder('utf-8').decode(rawContent);
        // Strip UTF-8 BOM if present
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        const firstLine = content.split(/\r?\n/, 1)[0] ?? '';
        return firstLine.trimStart().startsWith('//%attributes');
    } catch {
        return false;
    }
}

async function findErrorSourceUri(err: any): Promise<vscode.Uri | undefined> {
    // Try to find the .4dm file for the method/location reported in the error.
    // err fields like `method` or `text` may contain a method or class name,
    // possibly wrapped in extra prose. Pull every identifier-like token and try
    // each as a potential filename.
    const candidates = new Set<string>();
    const collect = (raw: unknown) => {
        if (typeof raw !== 'string') return;
        const tokens = raw.match(/[A-Za-z_][A-Za-z0-9_]*/g);
        if (tokens) tokens.forEach(t => candidates.add(t));
    };
    collect(err?.method);
    collect(err?.text);
    collect(err?.message);

    for (const name of candidates) {
        const matches = await vscode.workspace.findFiles(`**/${name}.4dm`, '**/node_modules/**', 1);
        if (matches.length > 0) {
            return matches[0];
        }
    }

    return undefined;
}

const findFilesCache = new Map<string, Promise<vscode.Uri | undefined>>();

async function findDmFileByName(fileBase: string): Promise<vscode.Uri | undefined> {
    const cached = findFilesCache.get(fileBase);
    if (cached) return cached;
    const p = Promise.resolve(
        vscode.workspace.findFiles(`**/${fileBase}.4dm`, '**/node_modules/**', 1)
    ).then(matches => matches[0]);
    findFilesCache.set(fileBase, p);
    return p;
}

async function findFrameSourceUri(frame: any): Promise<vscode.Uri | undefined> {
    const name = typeof frame?.name === 'string' ? frame.name : '';
    if (!name) return undefined;
    // classFunction names are "ClassName.methodName" — the file is ClassName.4dm.
    // projectMethod names are just the method name — the file is methodName.4dm.
    const fileBase = frame.type === 'classFunction' && name.includes('.')
        ? name.split('.')[0]
        : name;
    return findDmFileByName(fileBase);
}

async function resolveCallFrame(frame: any): Promise<vscode.TestMessageStackFrame> {
    const name = typeof frame?.name === 'string' ? frame.name : '';
    const line = typeof frame?.line === 'number' ? frame.line : null;
    const label = name || '<unnamed>';

    const fileUri = await findFrameSourceUri(frame);

    let position: vscode.Position | undefined;
    if (fileUri && line !== null) {
        let zeroBasedLine: number | null = null;
        if (frame.type === 'classFunction' && name.includes('.')) {
            zeroBasedLine = await mapFunctionLineToSourceLine(fileUri, name, line);
        } else {
            // Project method — count logical lines (handling \ continuations)
            // from the start of the file body, skipping //%attributes.
            zeroBasedLine = await mapProjectMethodLineToSourceLine(fileUri, line);
        }
        if (zeroBasedLine === null) {
            const hasAttr = await fileHasAttributeLine(fileUri);
            zeroBasedLine = (hasAttr ? line + 1 : line) - 1;
        }
        position = new vscode.Position(Math.max(0, zeroBasedLine), 0);
    }

    return new vscode.TestMessageStackFrame(label, fileUri, position);
}

function parseCallChainJSON(raw: unknown): any[] {
    if (typeof raw !== 'string' || !raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function handleResults(
    results: any,
    run: vscode.TestRun,
    testTargets: { suite: string; func: string; item: vscode.TestItem }[],
    controller: vscode.TestController
) {
    if (!results.testResults) return;

    if (results.hasGlobalErrors && results.globalErrors?.length > 0) {
        run.appendOutput('\r\n⚠ Global Runtime Errors (outside test processes):\r\n');
        for (const err of results.globalErrors) {
            const code = err.code ?? '?';
            const process = err.processNumber ?? '?';
            const method = err.text || 'Unknown location';
            const msg = err.message || err.method || '';
            const line = err.line != null ? ` line ${err.line}` : '';
            run.appendOutput(`  [${code}] Process ${process}: ${method}${line}\r\n`);
            if (msg) {
                run.appendOutput(`    ${msg}\r\n`);
            }
        }
        run.appendOutput('\r\n');
    }

    let processed = 0;
    let unmatched = 0;
    let i = 0;
    const totalCount = results.testResults.length;
    dbg(`handleResults: starting loop over ${totalCount} test results, ${testTargets.length} testTargets`);
    for (const testResult of results.testResults) {
        i++;
        const id = `${testResult.suite}.${testResult.name}`;
        const target = testTargets.find(
            t => t.suite === testResult.suite && t.func === testResult.name
        );

        if (!target) {
            unmatched++;
            dbg(`[${i}/${totalCount}] UNMATCHED ${id} (passed=${testResult.passed} skipped=${testResult.skipped} runtimeErrors=${testResult.runtimeErrors?.length ?? 0})`);
            run.appendOutput(
                `Warning: Could not find TestItem for ${id}\n`
            );
            continue;
        }

        const t0 = Date.now();
        try {
            dbg(`[${i}/${totalCount}] start ${id} (assertions=${testResult.assertions?.length ?? 0} runtimeErrors=${testResult.runtimeErrors?.length ?? 0} passed=${testResult.passed} skipped=${testResult.skipped})`);
            await processTestResult(testResult, target.item, run, controller);
            processed++;
            const elapsed = Date.now() - t0;
            if (elapsed > 100) {
                dbg(`[${i}/${totalCount}] done  ${id} (${elapsed}ms) [SLOW]`);
            } else {
                dbg(`[${i}/${totalCount}] done  ${id} (${elapsed}ms)`);
            }
        } catch (err: any) {
            dbg(`[${i}/${totalCount}] ERROR ${id} (${Date.now() - t0}ms): ${err?.message ?? err}`);
            dbg(`stack: ${err?.stack ?? '(no stack)'}`);
            run.appendOutput(
                `Error processing ${id}: ${err?.message ?? err}\n`
            );
            // Ensure the parent test doesn't stay in "running" forever.
            run.errored(
                target.item,
                new vscode.TestMessage(
                    `Internal error while processing result: ${err?.message ?? err}`
                ),
                testResult.duration ?? 0
            );
        }
    }
    dbg(`handleResults: processed=${processed}, unmatched=${unmatched}, total=${totalCount}`);
}

async function processTestResult(
    testResult: any,
    funcItem: vscode.TestItem,
    run: vscode.TestRun,
    controller: vscode.TestController
) {
    const id = `${testResult.suite}.${testResult.name}`;
    const realAssertions = (testResult.assertions ?? []).filter(
            (a: any) => !a.isRuntimeError
        );
        const runtimeErrorAssertions = (testResult.assertions ?? []).filter(
            (a: any) => a.isRuntimeError
        );
        const primaryRuntimeError =
            testResult.runtimeErrors?.[0] ?? runtimeErrorAssertions[0];
        const hasRuntimeError = primaryRuntimeError != null;
        dbg(`  ${id}: realAssertions=${realAssertions.length}, hasRuntimeError=${hasRuntimeError}`);

        // Pass 1: create child items (assertions + optional runtime-error child)
        const assertionItems: vscode.TestItem[] = [];

        for (let index = 0; index < realAssertions.length; index++) {
            const assertion = realAssertions[index];

            let label = assertion.message || `Assertion ${index + 1}`;
            if (label.length > 80) {
                label = label.substring(0, 77) + '...';
            }

            const assertionId = `${funcItem.id}/assertion-${index}`;
            const assertionItem = controller.createTestItem(assertionId, label, funcItem.uri);

            if (assertion.line && assertion.functionName && funcItem.uri) {
                const sourceLine = await mapFunctionLineToSourceLine(
                    funcItem.uri,
                    assertion.functionName,
                    assertion.line
                );

                if (sourceLine !== null) {
                    const position = new vscode.Position(sourceLine, 0);
                    const range = new vscode.Range(position, position);
                    assertionItem.range = range;
                }
            }

            if (!assertionItem.range && funcItem.range) {
                assertionItem.range = funcItem.range;
            }

            assertionItems.push(assertionItem);
        }

        // Build the runtime-error child item (points at the test function, like its parent)
        let runtimeErrorItem: vscode.TestItem | undefined;
        if (hasRuntimeError) {
            const err = primaryRuntimeError;
            const errMsg = err.message || err.method || `Error ${err.code ?? ''}`.trim();
            let label = `⚠ Runtime error: ${err.code != null ? `[${err.code}] ` : ''}${errMsg}`;
            if (label.length > 80) {
                label = label.substring(0, 77) + '...';
            }
            runtimeErrorItem = controller.createTestItem(
                `${funcItem.id}/runtime-error`,
                label,
                funcItem.uri
            );
            if (funcItem.range) {
                runtimeErrorItem.range = funcItem.range;
            }
            assertionItems.push(runtimeErrorItem);
        }

        // Attach items to the tree before setting run states
        dbg(`  ${id}: built ${assertionItems.length} child items, calling children.replace`);
        funcItem.children.replace(assertionItems);
        dbg(`  ${id}: children.replace done`);

        // Pass 2: set run states for assertion children
        for (let index = 0; index < realAssertions.length; index++) {
            const assertion = realAssertions[index];
            const assertionItem = assertionItems[index];

            run.started(assertionItem);

            if (assertion.passed) {
                run.passed(assertionItem);
            } else {
                const failureLines: string[] = [];
                const expectedStr = JSON.stringify(assertion.expected);
                const actualStr = JSON.stringify(assertion.actual);
                failureLines.push(`Expected: ${expectedStr}, Actual: ${actualStr}`);
                if (assertion.message) {
                    failureLines.push(`\nAssertion: ${assertion.message}`);
                }

                const message = new vscode.TestMessage(failureLines.join('\n'));

                if (assertionItem.range && funcItem.uri) {
                    message.location = new vscode.Location(funcItem.uri, assertionItem.range);
                }

                run.failed(assertionItem, message);
            }
        }

        // Set state on the runtime-error child (full message + stack lives here)
        if (runtimeErrorItem && primaryRuntimeError) {
            dbg(`  ${id}: building runtime-error message + stack trace`);
            const err = primaryRuntimeError;
            const summaryParts: string[] = [];
            let errorFrame: vscode.TestMessageStackFrame | undefined;

            const errMsg = err.message || err.method || `Error ${err.code ?? ''}`.trim();
            summaryParts.push(`Runtime error: ${err.code != null ? `[${err.code}] ` : ''}${errMsg}`);
            if (err.text) {
                summaryParts.push(`Location: ${err.text}`);
            }
            // Inline decoration anchor (where the red arrow appears in the editor).
            // Stays in the test file so the user can see it in context.
            let decorationUri: vscode.Uri | undefined;
            let decorationRange: vscode.Range | undefined;

            if (err.line != null) {
                const testFileBaseName = funcItem.uri
                    ? (funcItem.uri.path.split('/').pop() ?? '').replace(/\.4dm$/, '')
                    : '';
                const errText = typeof err.text === 'string' ? err.text : '';
                const isInTestClass = testFileBaseName !== '' && errText !== '' &&
                    (errText === testFileBaseName || errText.startsWith(`${testFileBaseName}.`));

                // Resolve the actual error location (file + 0-based line) for the stack frame.
                let errorSourceUri: vscode.Uri | undefined;
                let errorZeroBasedLine: number | null = null;

                if (isInTestClass && funcItem.uri) {
                    errorSourceUri = funcItem.uri;
                    errorZeroBasedLine = await mapFunctionLineToSourceLine(
                        funcItem.uri,
                        errText,
                        err.line
                    );
                } else {
                    errorSourceUri = await findErrorSourceUri(err);
                    if (errorSourceUri) {
                        if (errText && errText.includes('.')) {
                            errorZeroBasedLine = await mapFunctionLineToSourceLine(
                                errorSourceUri,
                                errText,
                                err.line
                            );
                        } else {
                            // Project method — count logical lines with \ continuations
                            errorZeroBasedLine = await mapProjectMethodLineToSourceLine(
                                errorSourceUri,
                                err.line
                            );
                        }
                        if (errorZeroBasedLine === null) {
                            const hasAttr = await fileHasAttributeLine(errorSourceUri);
                            errorZeroBasedLine = (hasAttr ? err.line + 1 : err.line) - 1;
                        }
                    }
                }

                summaryParts.push(
                    `Line: ${errorZeroBasedLine !== null ? errorZeroBasedLine + 1 : err.line}`
                );

                // Stack frame always points at the actual error location.
                if (errorSourceUri && errorZeroBasedLine !== null) {
                    const pos = new vscode.Position(errorZeroBasedLine, 0);
                    const label = errText || err.method || 'Error location';
                    errorFrame = new vscode.TestMessageStackFrame(label, errorSourceUri, pos);
                }

                // Decoration anchor: actual line if in the test class, otherwise the test function.
                if (isInTestClass && errorSourceUri && errorZeroBasedLine !== null) {
                    const pos = new vscode.Position(errorZeroBasedLine, 0);
                    decorationUri = errorSourceUri;
                    decorationRange = new vscode.Range(pos, pos);
                } else if (funcItem.uri && funcItem.range) {
                    decorationUri = funcItem.uri;
                    decorationRange = funcItem.range;
                }
            }

            // Resolve every call-chain frame to a clickable TestMessageStackFrame.
            // The VS Code stack trace UI renders these directly — no need to
            // duplicate them in the message body.
            const errCallChain = parseCallChainJSON(err.callChainJSON);
            const chainForStack = errCallChain.length > 0 ? errCallChain : (testResult.callChain ?? []);
            dbg(`  ${id}: resolving ${chainForStack.length} stack frames`);
            const tStack = Date.now();

            const stackFrames: vscode.TestMessageStackFrame[] = [];
            for (const frame of chainForStack) {
                stackFrames.push(await resolveCallFrame(frame));
            }
            dbg(`  ${id}: resolved ${stackFrames.length} frames in ${Date.now() - tStack}ms`);

            const message = new vscode.TestMessage(summaryParts.join('\n'));
            if (decorationUri && decorationRange) {
                message.location = new vscode.Location(decorationUri, decorationRange);
                runtimeErrorItem.range = decorationRange;
            } else if (funcItem.uri && runtimeErrorItem.range) {
                message.location = new vscode.Location(funcItem.uri, runtimeErrorItem.range);
            }
            if (stackFrames.length > 0) {
                message.stackTrace = stackFrames;
            } else if (errorFrame) {
                message.stackTrace = [errorFrame];
            }

            run.started(runtimeErrorItem);
            run.errored(runtimeErrorItem, message);
            dbg(`  ${id}: runtime-error child marked errored`);
        }

        // Parent state — when a runtime error occurs, the runtime-error child
        // owns the failure entry; mark the parent as passed so it doesn't
        // duplicate the failure in the Test Results output. The child's errored
        // state still propagates to the parent's icon in the Test Explorer tree.
        if (testResult.skipped) {
            dbg(`  ${id}: parent → skipped`);
            run.skipped(funcItem);
        } else if (hasRuntimeError) {
            dbg(`  ${id}: parent → passed (runtime error owns failure)`);
            run.passed(funcItem, testResult.duration ?? 0);
        } else if (testResult.passed) {
            dbg(`  ${id}: parent → passed`);
            run.passed(funcItem, testResult.duration ?? 0);
        } else {
            const failedCount = testResult.assertions?.filter((a: any) => !a.passed).length ?? 0;
            dbg(`  ${id}: parent → failed (${failedCount}/${testResult.assertionCount} assertions failed)`);
            const summaryMsg = new vscode.TestMessage(
                `${failedCount} of ${testResult.assertionCount} assertions failed`
            );
            run.failed(funcItem, summaryMsg, testResult.duration ?? 0);
        }
}
