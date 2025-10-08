import * as vscode from 'vscode';

const headingRe = /^.*?(?:\/\/ #tags: (.*))?\nFunction (test_.*)\(.*$/;

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

        // Find the function definition line
        let functionStartLine = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.match(new RegExp(`^Function\\s+${methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`))) {
                functionStartLine = i;
                break;
            }
        }

        if (functionStartLine === -1) {
            return null; // Function not found
        }

        // Now count logical lines (4D lines) vs actual lines
        // 4D counts lines ending with \ as part of the same logical line
        // 4D treats the function declaration as line 0, so start from the next line
        let logicalLinesCompleted = 0;
        let lineIndex = functionStartLine + 1;

        while (lineIndex < lines.length) {
            const currentLine = lines[lineIndex];

            // Check if this line ends with a continuation character
            // Note: We need to check for \ at the end, ignoring trailing whitespace
            const trimmedLine = currentLine.trimEnd();
            const hasContinuation = trimmedLine.endsWith('\\');

            if (!hasContinuation) {
                // End of a logical line
                logicalLinesCompleted++;

                // Check if this is the line we're looking for
                if (logicalLinesCompleted === lineOffset) {
                    return lineIndex; // Found it!
                }
            }

            lineIndex++;
        }

        // Didn't find the target line
        return null;

    } catch (err) {
        console.error(`Error mapping function line to source line:`, err);
        return null;
    }
}
