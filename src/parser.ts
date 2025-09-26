import * as vscode from 'vscode';

// Regex to match either a test or a heading
// Group 1 = test function name, group 2 = test args
// Group 3 = heading tags (optional), group 4 = heading function name
const combinedRe = /(?:\$t\.assert\.([A-Za-z_]\w*)\s*\(\s*([\s\S]*?)\))|(?:^(?:\/\/ #tags: (.*)\r?\n)?Function (test_.*)\(.*$)/gm;

export const parseMarkdown = (
    text: string,
    events: {
        onTest(
            range: vscode.Range,
            actual: string,
            operator: string,
            expected: string,
            should: string
        ): void;
        onHeading(
            range: vscode.Range,
            name: string,
            depth: number,
            headingTags: string[]
        ): void;
    }
): boolean => {
    let foundFunction = false;
    let match: RegExpExecArray | null;

    while ((match = combinedRe.exec(text)) !== null) {
        // --- Test match ---
        if (match[1] && match[2]) {
            const operator = match[1];
            const argsRaw = match[2];

            // Split args safely on semicolons not inside () or ""
            const argRegex = /;(?=(?:[^()"]|\([^()]*\)|"[^"]*")*$)/;
            const args = argsRaw.split(argRegex).map(a => a.trim()).filter(Boolean);

            const actual   = args[1] ?? "";
            const expected = args[2] ?? "";
            const should   = args[3] ?? "";

            // Use match.index / match[0].length instead of indices
            const start = match.index;
            const end = match.index + match[0].length;
            const range = new vscode.Range(positionAt(text, start), positionAt(text, end));

            events.onTest(range, actual, operator, expected, should);
            continue;
        }

        // --- Heading match ---
        if (match[3] !== undefined && match[4]) {
            foundFunction = true;
            const tagsString = match[3] || "unit";
            const name = match[4];
            const depth = tagsString.split(':').length;
            const headingTags = tagsString.split(',').map(t => t.trim());

            // Range should begin at the "Function" line, not the optional tags line
            const matchText = match[0];
            const functionOffset = matchText.indexOf("Function");
            const start = match.index + functionOffset;
            const end = match.index + matchText.length;
            const range = new vscode.Range(positionAt(text, start), positionAt(text, end));

            events.onHeading(range, name, depth, headingTags);
        }
    }

    return foundFunction;
};

// Convert raw offset → vscode.Position
function positionAt(text: string, offset: number): vscode.Position {
    const lines = text.slice(0, offset).split(/\r?\n/);
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}
