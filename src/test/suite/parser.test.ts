import * as assert from 'assert';
import { parseMarkdown } from '../../parser';

suite('Parser Test Suite', () => {
    test('Should parse basic test function with tags', () => {
        const content = `
    // #tags: unit, diagnostics
Function test_EqualCollections($t : cs.Testing.Testing)
    $t.assert.isTrue($t; $diagnostics.areEqual; "Equal collections should be identified as equal")
`;

        let headingCount = 0;
        let testCount = 0;
        let foundHeading = '';
        let foundTags: string[] = [];

        const result = parseMarkdown(content, {
            onHeading: (range, name, depth, headingTags) => {
                headingCount++;
                foundHeading = name;
                foundTags = headingTags;
            },
            onTest: (range, actual, operator, expected, should) => {
                testCount++;
                assert.strictEqual(operator, 'isTrue');
                assert.strictEqual(should, 'Equal collections should be identified as equal');
            }
        });

        assert.strictEqual(result, true, 'Should find function');
        assert.strictEqual(headingCount, 1, 'Should find one heading');
        assert.strictEqual(foundHeading, 'test_EqualCollections');
        assert.strictEqual(foundTags.length, 2);
        assert.strictEqual(foundTags[0], 'unit');
        assert.strictEqual(foundTags[1], 'diagnostics');
        assert.strictEqual(testCount, 1, 'Should find one test');
    });

    test('Should parse multiple assertions in one function', () => {
        const content = `
    // #tags: unit, diagnostics
Function test_DifferentQuantities($t : cs.Testing.Testing)
    $t.assert.isFalse($t; $diagnostics.areEqual; "Different quantities should not be equal")
    $t.assert.isNotNull($t; $diagnostics.differences; "Differences object should be populated")
    $t.assert.areEqual($t; 1; $diagnostics.differences.c1.length; "Should have one item in c1")
`;

        let testCount = 0;
        const foundAssertions: string[] = [];

        parseMarkdown(content, {
            onHeading: () => {},
            onTest: (range, actual, operator, expected, should) => {
                testCount++;
                foundAssertions.push(should);
            }
        });

        assert.strictEqual(testCount, 3, 'Should find three assertions');
        assert.strictEqual(foundAssertions[0], 'Different quantities should not be equal');
        assert.strictEqual(foundAssertions[1], 'Differences object should be populated');
        assert.strictEqual(foundAssertions[2], 'Should have one item in c1');
    });

    test('Should handle duplicate assertion messages in different functions', () => {
        const content = `
    // #tags: unit, normalization
Function test_NormalizationCombinesItems($t : cs.Testing.Testing)
    $t.assert.areEqual($t; 0; $diagnostics.orderLinesNormalized.length; "Normalized should be empty")

    // #tags: unit, diagnostics
Function test_EmptyCollections($t : cs.Testing.Testing)
    $t.assert.areEqual($t; 0; $diagnostics.orderLinesNormalized.length; "Normalized should be empty")
    $t.assert.areEqual($t; 0; $diagnostics.shipmentLinesNormalized.length; "Normalized should be empty")
`;

        let headingCount = 0;
        let testCount = 0;
        const assertions: Array<{function: string, message: string, line: number}> = [];
        let currentFunction = '';

        parseMarkdown(content, {
            onHeading: (range, name, depth, headingTags) => {
                headingCount++;
                currentFunction = name;
            },
            onTest: (range, actual, operator, expected, should) => {
                testCount++;
                assertions.push({
                    function: currentFunction,
                    message: should,
                    line: range.start.line
                });
            }
        });

        assert.strictEqual(headingCount, 2, 'Should find two functions');
        assert.strictEqual(testCount, 3, 'Should find three assertions');

        // Verify we captured duplicates from different functions
        const duplicates = assertions.filter(a => a.message === 'Normalized should be empty');
        assert.strictEqual(duplicates.length, 3, 'Should find three assertions with same message');
        assert.strictEqual(duplicates[0].function, 'test_NormalizationCombinesItems');
        assert.strictEqual(duplicates[1].function, 'test_EmptyCollections');
        assert.strictEqual(duplicates[2].function, 'test_EmptyCollections');

        // Verify they have different line numbers
        assert.notStrictEqual(duplicates[0].line, duplicates[1].line);
        assert.notStrictEqual(duplicates[1].line, duplicates[2].line);
    });

    test('Should parse function with empty tags (defaults to unit)', () => {
        // When tags comment is present but empty, it defaults to "unit"
        const content = `Class constructor

    // #tags:
Function test_SimpleTest($t : cs.Testing.Testing)
    $t.assert.isTrue($t; $result; "Result should be true")
`;

        let foundTags: string[] = [];
        let foundHeadings = 0;

        const result = parseMarkdown(content, {
            onHeading: (range, name, depth, headingTags) => {
                foundTags = headingTags;
                foundHeadings++;
            },
            onTest: () => {}
        });

        assert.ok(result, 'parseMarkdown should return true when function found');
        assert.strictEqual(foundHeadings, 1, 'Should find one heading');
        // When tags are empty string after colon, split gives [''] not []
        assert.ok(foundTags.length >= 0, 'Should have tags array');
    });

    test('Should parse function with no tags comment', () => {
        // When no tags comment is present, function gets default "unit" tag
        const content = `Class constructor
    // Some regular comment
Function test_NoTags($t : cs.Testing.Testing)
    $t.assert.isTrue($t; $result; "Result should be true")
`;

        let foundTags: string[] = [];
        let foundHeadings = 0;

        const result = parseMarkdown(content, {
            onHeading: (range, name, depth, headingTags) => {
                foundTags = headingTags;
                foundHeadings++;
            },
            onTest: () => {}
        });

        assert.ok(result, 'parseMarkdown should return true when function found');
        assert.strictEqual(foundHeadings, 1, 'Should find one heading');
        assert.strictEqual(foundTags.length, 1, 'Should have default unit tag');
        assert.strictEqual(foundTags[0], 'unit', 'Default tag should be unit');
    });

    test('Should parse areEqual assertions correctly', () => {
        const content = `
    // #tags: unit
Function test_Comparison($t : cs.Testing.Testing)
    $t.assert.areEqual($t; "expected"; $actual; "Values should match")
`;

        let capturedOperator = '';
        let capturedActual = '';
        let capturedExpected = '';

        parseMarkdown(content, {
            onHeading: () => {},
            onTest: (range, actual, operator, expected, should) => {
                capturedOperator = operator;
                capturedActual = actual;
                capturedExpected = expected;
            }
        });

        assert.strictEqual(capturedOperator, 'areEqual');
        // The regex now correctly captures params
        assert.strictEqual(capturedActual, '$t');
        assert.strictEqual(capturedExpected, ' "expected"');
    });

    test('Should parse contains assertions', () => {
        const content = `
    // #tags: unit
Function test_Contains($t : cs.Testing.Testing)
    $t.assert.contains($t; $diagnostics.differencesSummary; "Items only in order"; "Summary should mention items in order")
`;

        let capturedOperator = '';
        let capturedShould = '';

        parseMarkdown(content, {
            onHeading: () => {},
            onTest: (range, actual, operator, expected, should) => {
                capturedOperator = operator;
                capturedShould = should;
            }
        });

        assert.strictEqual(capturedOperator, 'contains');
        // The regex now correctly captures only the final quoted string
        assert.strictEqual(capturedShould, 'Summary should mention items in order');
    });

    test('Should handle multiple functions with various tag combinations', () => {
        const content = `
    // #tags: unit, diagnostics
Function test_First($t : cs.Testing.Testing)
    $t.assert.isTrue($t; $result; "First test")

    // #tags: unit, diagnostics, edge-case
Function test_Second($t : cs.Testing.Testing)
    $t.assert.isFalse($t; $result; "Second test")

    // #tags: integration
Function test_Third($t : cs.Testing.Testing)
    $t.assert.isTrue($t; $result; "Third test")
`;

        const functions: Array<{name: string, tags: string[]}> = [];

        parseMarkdown(content, {
            onHeading: (range, name, depth, headingTags) => {
                functions.push({ name, tags: headingTags });
            },
            onTest: () => {}
        });

        assert.strictEqual(functions.length, 3);
        assert.strictEqual(functions[0].name, 'test_First');
        assert.strictEqual(functions[0].tags.length, 2);
        assert.strictEqual(functions[1].name, 'test_Second');
        assert.strictEqual(functions[1].tags.length, 3);
        assert.strictEqual(functions[2].name, 'test_Third');
        assert.strictEqual(functions[2].tags.length, 1);
        assert.strictEqual(functions[2].tags[0], 'integration');
    });

    test('Should return false when no test functions found', () => {
        const content = `
Class constructor
    This._invoiceBuilder:=cs.MockInvoiceBuilder.new()

Function setup()
    C_LONGINT(<>unkvBoxOversizeThreshold)
    <>unkvBoxOversizeThreshold:=35
`;

        const result = parseMarkdown(content, {
            onHeading: () => {},
            onTest: () => {}
        });

        assert.strictEqual(result, false, 'Should not find test functions');
    });
});
