import * as assert from 'assert';
import { parseMarkdown } from '../../parser';

suite('TestTree Test Suite', () => {
    test('Should generate different line numbers for duplicate assertion messages', () => {
        const testContent = `// Unit tests for testing duplicate assertions

    // #tags: unit, test
Function test_FirstFunction($t : cs.Testing.Testing)
    $t.assert.areEqual($t; 0; $result.length; "Should be empty")
    $t.assert.areEqual($t; 0; $result.count; "Should have zero items")

    // #tags: unit, test
Function test_SecondFunction($t : cs.Testing.Testing)
    $t.assert.areEqual($t; 0; $other.length; "Should be empty")
    $t.assert.areEqual($t; 0; $other.count; "Should have zero items")
`;

        const assertions: Array<{message: string, line: number, func: string}> = [];
        let currentFunc = '';

        parseMarkdown(testContent, {
            onHeading: (range, name) => {
                currentFunc = name;
            },
            onTest: (range, actual, operator, expected, should) => {
                assertions.push({
                    message: should,
                    line: range.start.line,
                    func: currentFunc
                });
            }
        });

        // Verify we got 4 assertions
        assert.strictEqual(assertions.length, 4, 'Should have 4 assertions');

        // Find assertions with same message
        const emptyAssertions = assertions.filter(a => a.message === 'Should be empty');
        assert.strictEqual(emptyAssertions.length, 2, 'Should have 2 "Should be empty" assertions');

        // Verify they have different line numbers
        assert.notStrictEqual(emptyAssertions[0].line, emptyAssertions[1].line,
            'Duplicate messages should be on different lines');

        // Verify they are in different functions
        assert.notStrictEqual(emptyAssertions[0].func, emptyAssertions[1].func,
            'Duplicate messages should be in different functions');
    });

    test('Should correctly identify line numbers for unique ID generation', () => {
        const testContent = `// Test line-based IDs

    // #tags: unit
Function test_LineNumbers($t : cs.Testing.Testing)
    $t.assert.areEqual($t; 1; $a; "Same message")
    $t.assert.areEqual($t; 2; $b; "Same message")
    $t.assert.areEqual($t; 3; $c; "Same message")
`;

        const lines: number[] = [];

        parseMarkdown(testContent, {
            onHeading: () => {},
            onTest: (range) => {
                lines.push(range.start.line);
            }
        });

        assert.strictEqual(lines.length, 3, 'Should have 3 assertions');

        // Verify all line numbers are different
        const uniqueLines = new Set(lines);
        assert.strictEqual(uniqueLines.size, 3, 'All assertions should be on different lines');

        // Verify lines are sequential
        assert.strictEqual(lines[1], lines[0] + 1, 'Lines should be sequential');
        assert.strictEqual(lines[2], lines[1] + 1, 'Lines should be sequential');
    });

    test('Should parse multiple functions with duplicate messages across them', () => {
        const testContent = `
    // #tags: unit
Function test_First($t : cs.Testing.Testing)
    $t.assert.areEqual($t; 0; $a; "Value should be zero")
    $t.assert.areEqual($t; 0; $b; "Value should be zero")

    // #tags: unit
Function test_Second($t : cs.Testing.Testing)
    $t.assert.areEqual($t; 0; $c; "Value should be zero")
    $t.assert.areEqual($t; 0; $d; "Value should be zero")
`;

        const testsByFunction = new Map<string, Array<{message: string, line: number}>>();

        parseMarkdown(testContent, {
            onHeading: (range, name) => {
                testsByFunction.set(name, []);
            },
            onTest: (range, actual, operator, expected, should) => {
                const currentFunc = Array.from(testsByFunction.keys()).pop()!;
                testsByFunction.get(currentFunc)!.push({
                    message: should,
                    line: range.start.line
                });
            }
        });

        // Verify we have 2 functions
        assert.strictEqual(testsByFunction.size, 2, 'Should have 2 functions');

        // Each function should have 2 tests
        testsByFunction.forEach((tests, funcName) => {
            assert.strictEqual(tests.length, 2, `${funcName} should have 2 tests`);
        });

        // All 4 assertions have the same message but different line numbers
        const allTests = Array.from(testsByFunction.values()).flat();
        const allMessages = allTests.map(t => t.message);
        const allLines = allTests.map(t => t.line);

        // All have same message
        assert.ok(allMessages.every(m => m === 'Value should be zero'), 'All messages should be the same');

        // But all have different line numbers
        const uniqueLines = new Set(allLines);
        assert.strictEqual(uniqueLines.size, 4, 'All 4 assertions should have unique line numbers');
    });

    test('Should handle tag inheritance concept via parser', () => {
        const testContent = `
    // #tags: unit, integration, api
Function test_WithTags($t : cs.Testing.Testing)
    $t.assert.isTrue($t; $result; "Should pass")
`;

        let capturedTags: string[] = [];
        let testCount = 0;

        parseMarkdown(testContent, {
            onHeading: (range, name, depth, headingTags) => {
                capturedTags = headingTags;
            },
            onTest: () => {
                testCount++;
            }
        });

        assert.strictEqual(capturedTags.length, 3, 'Should have 3 tags');
        assert.strictEqual(capturedTags[0], 'unit');
        assert.strictEqual(capturedTags[1], 'integration');
        assert.strictEqual(capturedTags[2], 'api');
        assert.strictEqual(testCount, 1, 'Should have 1 test');
    });
});
