# Evidence rule

This rule decides whether a line of a PR description says something or is an unfilled placeholder. `src/evidence.ts` implements it. `test/placeholders.test.ts` reads the table below and checks every row inside every wrapper the tests know: list items, task boxes, quotes, indentation, table cells, bold labels and HTML. So this file is the spec, and the test fails when the spec and the code disagree.

## The rule

1. **Normalize.** Repeat until nothing changes:
   - decode HTML entities (numeric, hex and named), repeating until none are left, so a double-encoded `&amp;#84;` becomes `T`;
   - apply NFKD and drop combining marks (`\p{M}`), so `TÓDO` and a struck-through `T̶O̶D̶O̶` read as `TODO`;
   - fold Cyrillic and Greek letters that look like Latin ones to the Latin letter (`ТОDО` with Cyrillic `Т` and `О` reads as `TODO`);
   - drop format characters (`\p{Cf}`, e.g. zero-width spaces);
   - drop `<summary>...</summary>`;
   - unwrap link and image text (`[text](url)` and `![text](url)` become `text`);
   - remove the other HTML tags;
   - drop an unchecked task item: once list and quote markers are gone, a line that starts with `[ ]` is empty, whatever follows (`- [ ] ran the unit tests`). An unchecked box means not done. A checked box (`[x]`) is stripped and its text is judged;
   - strip list, quote, task-box and number markers;
   - split a table row into cells;
   - drop a line or cell that is only a bracketed prompt (`[paste output here]`);
   - remove emphasis (`*`, `_`, `~`, backticks);
   - remove everything before the first letter or digit.
2. **Split.** Split at the first label separator into a label and the pieces after it. A separator is `:`, a dash with a space on each side (` - `, ` – `, ` — `), a parenthesised `(...)` (the text inside and the text after are separate pieces), or a table cell boundary. A hyphen without spaces (`TBD-free`) is not a separator.
3. **Decide.** Check these in order. The first one that applies decides.
   1. No letter or digit: empty.
   2. **Placeholder first word.** The line starts with a placeholder word: `TODO`, `TBD`, `TBA`, `WIP`, `FIXME`, `Pending`, or the phrases `No response` and `Not tested`. A word joined by a hyphen (`TBD-free`, `TODO-list`) is a different word, not a placeholder. Then the line is empty unless the text after its label reports a result. A result is any of these:
      - a non-zero count followed by `passed`, `passing`, `pass`, `ok` or `cases`, optionally with `test` or `tests` between (`12 tests passed`);
      - an `N/N` score with equal numbers (`3/3`);
      - one of the words `passed`, `passes`, `green`.

      So `12 passed` and `npm test passed` are results. Issue numbers (`#42`), versions (`v2`, `Node 20`), `PR 2`, `0 passed`, `0 so far` and a bare `5 tests` are not. A line with no separator has no text after a label, so it is empty (`TODO add tests later`, `WIP, tests coming`, `Pending`).
   3. **No separator.** The line has content unless nothing but placeholder tokens and punctuation is left: the words above, `N/A`, `NA`, `fill this in` and `fill me in`.
   4. **Placeholder label.** Empty when the label is nothing but placeholder tokens (`TODO: describe tests` is a prompt, not an answer).
   5. **The pieces.** Otherwise each piece after the label is judged by this same rule. The line is empty when every piece is empty.

   A section is filled when at least one of its lines has content. Table header rows never count.

The placeholder first-word test applies to the line and, through the recursion, to the text after a label. A placeholder word at the start of a longer label (`TODO list feature tested: 12 passed`) only asks for a result. Apart from that, and from step 4, the label's own words never count. The label can have any number of words.

Judgment calls the rule makes on purpose:
- **One rule for `N/A`.** `N/A` counts only when a reason follows it on the same line and the reason is not split off by a colon, a spaced dash, or parentheses. The accepted line is `N/A, no runtime change`. `N/A docs only` also counts, because a space is not a separator. A bare `N/A`, `N/A.`, and `NA` do not count. `N/A: docs only`, `N/A - docs only`, `N/A (docs only)`, and `N/A: later` do not count. The gate's fix text shows the accepted example.
- An answer that starts with a placeholder word, or whose label is only a placeholder, is empty: `WIP: 3/3 pass` and `Pending CI` count as empty. Write `3/3 pass` instead.
- A line that starts with a placeholder word needs a reported result after its label to count. So `TODO list feature tested: 12 passed` is filled, but `TODO list feature tested: all pass` is empty. Report the number or say it passed.
- A placeholder word used as an ordinary noun at the start of a line is still read as a placeholder: `WIP banner verified on staging`, `Todo list tests pass` and `No response received for invalid token, as expected` are empty. Start the line with what was tested, or add a result after a label (`WIP banner: verified on staging, 2 cases pass`).
- A prose sentence that ends in a placeholder after a colon (`We ran the suite and checked: TODO`) is empty, however long its label.
- **No clause rescue (fail closed).** A line with a placeholder in a later clause is empty even when an earlier clause reports a result: `Unit: 42 passed, e2e: N/A`, `npm test: 42 passed; integration: N/A` and `All 42 tests passed (TODO: add e2e)` are empty. A rescue (an earlier clause with a result fills the line) was tried and dropped after three rounds of review, because plans and targets read like results (`Will add 3 test cases; e2e: TODO`, `Target 12/12; e2e: TODO`, `Need 12 cases (TODO)`). Report the finished part on its own line.
- An unchecked task box (`- [ ] ran the unit tests`) means not done, so the line is empty. Tick the box (`- [x]`) or write the result.

## Worked examples

Values are JSON strings. The label and the pieces are what step 2 produces after step 1.

| Value | Label | Pieces after the label | Verdict |
| --- | --- | --- | --- |
| `"TODO"` | none | `TODO` (only a token) | empty |
| `"TODO: describe tests"` | `TODO` (a placeholder label) | `describe tests` | empty |
| `"TBD"` | none | `TBD` | empty |
| `"N/A"` | none | `N/A` | empty |
| `"-"` | none | nothing left after step 1 | empty |
| `""` | none | nothing | empty |
| `"\u200b"` | none | nothing (format character dropped) | empty |
| `"*TODO*"` | none | `TODO` | empty |
| `"\ud83d\udea7 TODO"` | none | `TODO` (leading emoji removed) | empty |
| `"\u26a0\ufe0f TODO"` | none | `TODO` | empty |
| `"Unit tests \u2014 TODO"` | `Unit tests` | `TODO` | empty |
| `"Unit tests \u2013 TODO"` | `Unit tests` | `TODO` | empty |
| `"Unit tests - TODO"` | `Unit tests` | `TODO` | empty |
| `"Tests (TODO)"` | `Tests` | `TODO`, nothing | empty |
| `"Unit and integration test suites: TODO"` | `Unit and integration test suites` | `TODO` | empty |
| `"Unit: Integration: TODO"` | `Unit` | `Integration: TODO`, which splits again into label `Integration` and `TODO` | empty |
| `"Unit: - [ ] TODO"` | `Unit` | `- [ ] TODO`, which normalizes to `TODO` | empty |
| `"[TODO](x)"` | none | `TODO` (link text) | empty |
| `"![TODO](x)"` | none | `TODO` (image text) | empty |
| `"Unit: ?"` | `Unit` | `?` (no letter or digit) | empty |
| `"Unit tests: ..."` | `Unit tests` | `...` | empty |
| `"&#84;ODO"` | none | `TODO` (entity decoded) | empty |
| `"&#x54;ODO"` | none | `TODO` | empty |
| `"Unit&colon; TODO"` | `Unit` | `TODO` | empty |
| `"<details><summary>Tests</summary>TODO</details>"` | none | `TODO` (summary dropped) | empty |
| `"TODO add tests later"` | none | `TODO add tests later` (first word `TODO`) | empty |
| `"TODO add tests"` | none | `TODO add tests` | empty |
| `"Unit tests: TODO add tests"` | `Unit tests` | `TODO add tests` (first word `TODO`) | empty |
| `"TBD once CI is set up"` | none | `TBD once CI is set up` | empty |
| `"WIP, tests coming"` | none | `WIP, tests coming` (a comma does not split) | empty |
| `"No response yet"` | none | `No response yet` | empty |
| `"FIXME"` | none | `FIXME` | empty |
| `"Unit: FIXME before merge"` | `Unit` | `FIXME before merge` | empty |
| `"TODO add tests (follow-up PR)"` | `TODO add tests` (starts with `TODO`) | `follow-up PR`, nothing (no result) | empty |
| `"TODO add tests (later)"` | `TODO add tests` | `later`, nothing | empty |
| `"TODO add tests - later"` | `TODO add tests` | `later` | empty |
| `"TODO add tests: later"` | `TODO add tests` | `later` | empty |
| `"Unit: TODO add tests (later)"` | `Unit` | `TODO add tests (later)`, which starts with `TODO` and reports no result after its label | empty |
| `"TODO add tests in a follow-up (#42)"` | `TODO add tests in a follow-up` | `#42`, nothing (an issue number is not a result) | empty |
| `"TODO add tests (see #12)"` | `TODO add tests` | `see #12`, nothing | empty |
| `"TODO add tests (follow-up #123)"` | `TODO add tests` | `follow-up #123`, nothing | empty |
| `"TODO add tests - follow-up in #12"` | `TODO add tests` | `follow-up in #12` | empty |
| `"TODO add tests (v2)"` | `TODO add tests` | `v2`, nothing (a version) | empty |
| `"TODO add e2e tests (Node 20)"` | `TODO add e2e tests` | `Node 20`, nothing | empty |
| `"TODO add tests: 0 so far"` | `TODO add tests` | `0 so far` (zero is not a result) | empty |
| `"TODO add tests - PR 2"` | `TODO add tests` | `PR 2` | empty |
| `"TODO add tests: 0 passed"` | `TODO add tests` | `0 passed` (zero) | empty |
| `"TODO add tests: 5 tests"` | `TODO add tests` | `5 tests` (a count with no outcome) | empty |
| `"TODO list feature tested: all pass"` | `TODO list feature tested` | `all pass` (no count) | empty |
| `"&amp;#84;ODO"` | none | `TODO` (double-encoded entity) | empty |
| `"\u0422\u041eD\u041e"` | none | `TODO` (Cyrillic `Т` and `О` folded) | empty |
| `"\u03a4\u039fD\u039f"` | none | `TODO` (Greek `Τ` and `Ο` folded) | empty |
| `"TO\u0301DO"` | none | `TODO` (combining mark dropped) | empty |
| `"T\u0336O\u0336D\u0336O\u0336"` | none | `TODO` (strike-through marks dropped) | empty |
| `"Pending"` | none | `Pending` | empty |
| `"Pending CI"` | none | starts with `Pending` | empty |
| `"Not tested yet"` | none | starts with `Not tested` | empty |
| `"Not tested"` | none | `Not tested` | empty |
| `"[paste output here]"` | none | nothing (a bracketed prompt) | empty |
| `"Unit: [describe tests]"` | `Unit` | nothing (a bracketed prompt) | empty |
| `"WIP banner verified on staging"` | none | starts with `WIP` (judgment call) | empty |
| `"Todo list tests pass"` | none | starts with `Todo` (judgment call) | empty |
| `"No response received for invalid token, as expected"` | none | starts with `No response` (judgment call) | empty |
| `"42 passed"` | none | `42 passed` | filled |
| ``"ran `npm test`, 42 passed"`` | none | `ran npm test, 42 passed` | filled |
| `"manual check on staging"` | none | `manual check on staging` | filled |
| `"TODO list feature tested: 12 passed"` | `TODO list feature tested` (not only tokens) | `12 passed` | filled |
| `"Todo app e2e: 4 passed"` | `Todo app e2e` | `4 passed` | filled |
| `"Todo app e2e: npm test passed; manually verified add/remove flows"` | `Todo app e2e` | `npm test passed; ...` (the word `passed`) | filled |
| `"TODO list feature tested: 12 tests passed"` | `TODO list feature tested` | `12 tests passed` | filled |
| `"TODO list feature tested: 3/3"` | `TODO list feature tested` | `3/3` | filled |
| `"WIP parser: CI green"` | `WIP parser` | `CI green` | filled |
| `"FIXME parser tests: 8 passed"` | `FIXME parser tests` | `8 passed` (a result) | filled |
| `"Unit: TODO list feature tested: 12 passed (CI run 7)"` | `Unit` | `TODO list feature tested: 12 passed (CI run 7)`, which reports `12 passed` after its label | filled |
| `"WIP flag tests pass: 3/3"` | `WIP flag tests pass` | `3/3` | filled |
| `"TBD-free: all 10 cases pass"` | `TBD-free` (the hyphen does not split) | `all 10 cases pass` | filled |
| `"Ran 5 tests (all pass)"` | `Ran 5 tests` | `all pass`, nothing | filled |
| `"[CI run](https://ci.example/run/1) \u2014 42 passed"` | `CI run` | `42 passed` | filled |
| `"https://ci.example/run/1"` | `https` | `ci.example/run/1` | filled |
| `"Unit: Integration: 7 passed"` | `Unit` | `Integration: 7 passed`, which has `7 passed` | filled |
| `"Unit: TODO list feature tested: 12 passed"` | `Unit` | `TODO list feature tested: 12 passed`, which splits again into label `TODO list feature tested` and `12 passed` | filled |
| `"Todos page renders: 3 passed"` | `Todos page renders` | `3 passed` | filled |
| `"Tested the TODO export: 5 passed"` | `Tested the TODO export` | `5 passed` | filled |
| `"Checked the WIP banner, 2 cases pass"` | none | first word `Checked` | filled |
| `"TBD-free regression suite passed"` | none | first word `TBD-free` (hyphenated, not a placeholder) | filled |
| `"TODO-list feature tests pass"` | none | first word `TODO-list` | filled |
| `"Pending migration verified: 3 passed"` | `Pending migration verified` | `3 passed` (a result) | filled |
| `"Тесты пройдены"` | none | Cyrillic text that is not a placeholder | filled |
| `"Prüfung bestanden: 12 Tests"` | `Prufung bestanden` | `12 Tests` | filled |

| `"N/A: docs only"` | `N/A` (a placeholder label) | `docs only` | empty |
| `"N/A - docs only"` | `N/A` (a placeholder label) | `docs only` | empty |
| `"N/A (docs only)"` | `N/A` (a placeholder label) | `docs only` | empty |
| `"N/A docs only"` | none | `N/A docs only` (more than placeholder tokens) | filled |
| `"N/A, no runtime change"` | none | `N/A, no runtime change` (a comma is not a separator) | filled |
| `"N/A."` | none | only a token | empty |
| `"N/A: none"` | `N/A` (a placeholder label) | `none` | empty |
| `"N/A: TODO"` | `N/A` (a placeholder label) | `TODO` | empty |
| `"N/A - N/A"` | `N/A` (a placeholder label) | `N/A` | empty |
| `"Unit: 42 passed, e2e: N/A"` | `Unit` | `42 passed, e2e: N/A`: label `42 passed, e2e`, piece `N/A` (no clause rescue) | empty |
| `"npm test: 42 passed; integration: N/A"` | `npm test` | `42 passed; integration: N/A`: piece `N/A` (no clause rescue) | empty |
| `"All 42 tests passed (TODO: add e2e)"` | `All 42 tests passed` | `TODO: add e2e` (no clause rescue) | empty |
| `"Unit: WIP, tests coming"` | `Unit` | `WIP, tests coming` (placeholder first word, no result) | empty |
| `"Unit: integration, e2e: TODO"` | `Unit` | `integration, e2e: TODO`: piece `TODO` | empty |
| `"Tests: 0 passed, e2e: N/A"` | `Tests` | piece `N/A` | empty |
| `"- [ ] ran the unit tests"` | none | unchecked task item | empty |
| `"> - [ ] 12 passed"` | none | unchecked task item | empty |
| `"- [x] ran the unit tests"` | none | `ran the unit tests` | filled |
| `"CI will go green; tests: TODO"` | `CI will go green; tests` | `TODO` | empty |
| `"Tests: will add once CI is green, e2e: TODO"` | `Tests` | `will add once CI is green, e2e: TODO`: piece `TODO` | empty |
| `"Hopefully passes; e2e: TBD"` | `Hopefully passes; e2e` | `TBD` | empty |
| `"Unit: integration, TODO get tests green, e2e: N/A"` | `Unit` | piece `N/A` after the nested label | empty |
| `"Unit: integration; not tested until CI passes; e2e: TODO"` | `Unit` | piece `TODO` after the nested label | empty |
| `"N/A: none, TBD"` | `N/A` (a placeholder label) | `none, TBD` | empty |
| `"N/A: none; TODO"` | `N/A` (a placeholder label) | `none; TODO` | empty |
| `"Will add 3 test cases; e2e: TODO"` | `Will add 3 test cases; e2e` | `TODO` (a plan, not a result) | empty |
| `"Plan to cover 5 cases, tests: TBD"` | `Plan to cover 5 cases, tests` | `TBD` | empty |
| `"Expect 10 tests passing, e2e: TODO"` | `Expect 10 tests passing, e2e` | `TODO` | empty |
| `"5 cases to write; unit: TODO"` | `5 cases to write; unit` | `TODO` | empty |
| `"will pass 5 cases later; e2e: TODO"` | `will pass 5 cases later; e2e` | `TODO` | empty |
| `"Target 12/12; e2e: TODO"` | `Target 12/12; e2e` | `TODO` | empty |
| `"Need 12 cases (TODO)"` | `Need 12 cases` | `TODO` | empty |
| `"N/A: will run tests"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A: will add"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A: will test after merge"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A: later"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A: not yet"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A: no tests yet"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A: in follow-up"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A - later"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A (later)"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
| `"N/A \u2014 later"` | `N/A` (a placeholder label) | a deferral, not a reason | empty |
