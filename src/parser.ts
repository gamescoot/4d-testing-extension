import * as vscode from 'vscode';

const testRe = /^.*\.assert\.(.*)\(.+?;(.+?);(.*?);* "(.+)"\)$/;
const headingRe = /^.*\/\/ #tags: (.*)\nFunction (test_.*)\(.*$/;

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
    const lines = text.split('\n');
    let lastline = '';
    let foundFunction = false;

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
        const line = lines[lineNo];

        // --- Tests ---
        const test = testRe.exec(line);
        if (test) {
            const [, operator, actual, expected, should] = test;
            const range = new vscode.Range(
                new vscode.Position(lineNo, 0),
                new vscode.Position(lineNo, test[0].length)
            );
            events.onTest(range, actual, operator, expected, should);
            lastline = line;
            continue;
        }

        // --- Headings ---
        const combined = (lastline ? lastline + '\n' : '') + line;
        const heading = headingRe.exec(combined);
        lastline = line;

        if (heading) {
            const [, tagsString, name] = heading;
            foundFunction = true;

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
