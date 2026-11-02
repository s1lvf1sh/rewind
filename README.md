# Rewind

**A small programming language with a time-travelling debugger.** Run a program once, then move anywhere in its history: step backwards as easily as forwards, step over and out of calls in either direction, run back to a breakpoint. Click any value, including a wrong printed answer, to ask *where it came from*. Rewind traces it back through every calculation, list and function call to its origins.

```
npm start            # http://localhost:8080
npm test             # 19 checks on the language, time travel, provenance and moves (<1 s)
npm run test:browser # 16 checks driving the real page in headless Firefox
```

No dependencies and no build step.

## Try the bug hunts

| Example | The puzzle | What Rewind shows |
|---|---|---|
| **The wrong average** | Prints 62.4 instead of 78 | Ask *why* on the output: it was made from scores 0–3 only, and 78 never went in. Line 7 ran 4 times, not 5 |
| **The crash** | Index out of range | It opens at the moment of the crash, with `j = 5` on a 5-item list and `a[j]` highlighted. Step back to the `let j = len(a)` that caused it |
| **The endless search** | Never finishes | Stopped after 100,000 steps, with the history intact. Scrub the timeline and `lo`, `mid` and `hi` freeze at 7, 7 and 8 |

Links share programs: `#ex=sort` opens an example, and edited programs are encoded in the link itself (`#code=…`).

## How it works

**Record once, travel anywhere.** The interpreter never changes state directly. Every change is a *write*: a scope created, a variable set, a list item stored, a call made, a line printed. Each write carries what's needed to undo it. `state.js` holds the only two functions that change state, `apply` and `undo`. The interpreter applies writes as it runs, and the debugger replays or undoes them to reach any step, so travel can't disagree with execution.

**Every value remembers its ingredients.** Each write records three kinds of dependency:
- **Data:** the writes whose values were computed into it.
- **Index:** the writes that chose *where* it was read from, such as `i` in `a[i]`.
- **Control:** the writes behind the conditions that let its code run.

These flow through arithmetic, lists, function arguments and return values. *Why?* follows the data links back to the **origins**: the writes with no inputs, meaning literals in the program text.

**Debugger moves**, in both directions: step, step over, step out, and continue to a breakpoint. They're plain searches over the recorded steps' call depth and line (`nav.js`).

## The language

Numbers, strings, booleans, `nil`, lists (by reference), functions with closures, `let`, assignment (`=`, `+=`, `-=`, `*=`), `if`/`else if`/`else`, `while`, `for x in list`, `break`, `continue` and `return`. Built-ins are `print len push pop range str abs floor sqrt min max`. Conditions must be `true` or `false`; the language doesn't guess. Errors name the problem and point at the exact expression, for example: *Expected ")" to close the "(" opened on line 1*.

## How it's checked

- **Time travel against an independent oracle.** Rewinding to step *t* must give exactly the state a *fresh run stopped at step t* reaches. That comparison is made at 355 positions in 8 programs, visited in scrambled order: all identical.
- **Language:** 19 programs with exact expected output (precedence, closures, aliasing, recursion, loops with break and continue), plus 15 kinds of mistake caught on the right line with a clear message.
- **Provenance** on known answers: the wrong average comes from scores 0–3; fib(8) traces back to its single 8; the discount depends on the item count only through the `if`; a swapped value is traced through the swap; values flow through calls and returns.
- **Debugger moves:** over, out, back out, breakpoints both ways, line run counts.
- **Speed:** 100,000 steps (80,000 writes) record in about 0.2 s, and a full rewind and replay takes about 65 ms.
- **The real page** in Firefox over WebDriver BiDi: clicking values, arrow keys, *Go there*, breakpoints, step out, the crash view, step over a recursion, editing, links, the infinite loop.

## Files

| File | What it holds |
|---|---|
| `src/parser.js` | Lexer and recursive-descent parser with source spans |
| `src/interp.js` | The tracing interpreter: steps, writes, provenance |
| `src/state.js` | `apply`, `undo`, and the `Cursor` that moves through time |
| `src/why.js` | Describing writes, origins, variable histories |
| `src/nav.js` | Debugger moves |
| `src/main.js` | The page |
| `src/examples.js` | Example programs and bug hunts |

MIT licensed.
