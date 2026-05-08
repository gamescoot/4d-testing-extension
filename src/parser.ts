import * as vscode from 'vscode';

const headingRe = /^.*?(?:\/\/ #tags: (.*))?\n?Function (test_.*)\(.*$/;

export const parseMarkdown = (
    text: string,
    events: {
        onHeading(
            range: vscode.Range,
            name: string,
            depth: number,
            headingTags: string[]
        ): void;
    }
): boolean => {
    const lines = text.split('\n');
    let lastline = '';
    let foundFunction = false;

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        const line = lines[lineNo];

        // --- Headings ---
        const combined = (lastline ? lastline + '\n' : '') + line;
        const heading = headingRe.exec(combined);
        lastline = line;

        if (heading) {
            var [, tagsString, name] = heading;
            foundFunction = true;
            tagsString = tagsString ? tagsString : "unit"
            const depth = tagsString ? tagsString.split(':').length : 1;
            const headingTags = tagsString ? tagsString.split(',').map(t => t.trim()) : [];

            const range = new vscode.Range(
                new vscode.Position(lineNo, 0),
                new vscode.Position(lineNo, line.length)
            );
            events.onHeading(range, name, depth, headingTags);
        }
    }

    return foundFunction;
};

/**
 * Maps a 4D function-relative line number to the actual source file line number.
 *
 * 4D counts lines with continuation characters (\) as a single line, but the source
 * file stores them as multiple lines. This function accounts for that difference.
 *
 * @param fileUri - URI of the source file
 * @param functionName - Fully qualified function name (e.g., "ClassName.methodName")
 * @param lineOffset - Line offset from the function start (1-based, as reported by 4D)
 * @returns The actual line number in the source file (0-based), or null if not found
 */
export async function mapFunctionLineToSourceLine(
    fileUri: vscode.Uri,
    functionName: string,
    lineOffset: number
): Promise<number | null> {
    try {
        // Read the source file
        const rawContent = await vscode.workspace.fs.readFile(fileUri);
        const content = new TextDecoder().decode(rawContent);
        const lines = content.split('\n');

        // Extract the method name from the fully qualified name
        // Format is typically "ClassName.methodName" or just "methodName"
        const methodName = functionName.split('.').pop() || functionName;

        // Find the function definition line. Allow optional modifiers like
        // `local` before the `Function` keyword (e.g., "local Function foo()").
        let functionStartLine = -1;
        const escapedName = methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const funcRe = new RegExp(`^(?:\\w+\\s+)*Function\\s+${escapedName}\\s*\\(`);
        for (let i = 0; i < lines.length; i++) {
            if (funcRe.test(lines[i].trim())) {
                functionStartLine = i;
                break;
            }
        }

        if (functionStartLine === -1) {
            return null; // Function not found
        }

        // Count logical lines (4D lines). Lines ending with `\` are continuations
        // of the same logical line; we return the FIRST physical line of each
        // logical line so the error lands at the start of the statement.
        let logicalLinesCompleted = 0;
        let logicalLineStart = functionStartLine + 1;
        let lineIndex = functionStartLine + 1;

        while (lineIndex < lines.length) {
            const trimmedLine = lines[lineIndex].trimEnd();
            const hasContinuation = trimmedLine.endsWith('\\');

            if (!hasContinuation) {
                logicalLinesCompleted++;
                if (logicalLinesCompleted === lineOffset) {
                    return logicalLineStart;
                }
                logicalLineStart = lineIndex + 1;
            }
            lineIndex++;
        }

        return null;

    } catch (err) {
        console.error(`Error mapping function line to source line:`, err);
        return null;
    }
}

/**
 * Maps a 4D project-method line number to the actual source file line number.
 *
 * Project methods don't have a `Function` declaration — the file body is the
 * method. 4D skips a leading //%attributes directive and treats lines ending
 * with `\` as continuations of a single logical line, so we mirror that here.
 *
 * @param fileUri - URI of the source file
 * @param lineOffset - 1-based line number reported by 4D (relative to the start
 *   of the method body, after any //%attributes)
 * @returns The actual 0-based line number in the source file, or null on failure
 */
export async function mapProjectMethodLineToSourceLine(
    fileUri: vscode.Uri,
    lineOffset: number
): Promise<number | null> {
    try {
        const rawContent = await vscode.workspace.fs.readFile(fileUri);
        let content = new TextDecoder('utf-8').decode(rawContent);
        if (content.charCodeAt(0) === 0xFEFF) {
            content = content.slice(1);
        }
        const lines = content.split('\n');

        // 4D skips a leading //%attributes line — start counting after it.
        let startIndex = 0;
        if (lines.length > 0 && lines[0].trimStart().startsWith('//%attributes')) {
            startIndex = 1;
        }

        // Return the FIRST physical line of each logical line (so errors land at
        // the start of multi-line statements joined with `\`).
        let logicalLinesCompleted = 0;
        let logicalLineStart = startIndex;
        let lineIndex = startIndex;

        while (lineIndex < lines.length) {
            const trimmedLine = lines[lineIndex].trimEnd();
            const hasContinuation = trimmedLine.endsWith('\\');

            if (!hasContinuation) {
                logicalLinesCompleted++;
                if (logicalLinesCompleted === lineOffset) {
                    return logicalLineStart;
                }
                logicalLineStart = lineIndex + 1;
            }
            lineIndex++;
        }
        return null;
    } catch (err) {
        console.error('Error mapping project method line to source line:', err);
        return null;
    }
}
