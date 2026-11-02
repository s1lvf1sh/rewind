// Example programs. The ones marked "bug" are puzzles: run them, then work backwards
// from the wrong answer (or the crash) to its cause.

export const EXAMPLES = [
  {
    id: 'average',
    title: 'Bug hunt: the wrong average',
    hint: 'The average of these five scores should be 78, but the program prints 62.4. Click the printed line and ask why. Which scores actually went into it?',
    code: `# Average of five test scores. Should print 78.
let scores = [72, 85, 64, 91, 78]

fn average(xs) {
  let total = 0
  for i in range(len(xs) - 1) {
    total += xs[i]
  }
  return total / len(xs)
}

print("average:", average(scores))
`,
  },
  {
    id: 'reverse',
    title: 'Bug hunt: the crash',
    hint: 'This crashes. Rewind is already at the moment of the crash: look at i and j, then step backwards to see how they got there.',
    code: `# Reverse a list in place by swapping from both ends.
fn reverse(a) {
  let i = 0
  let j = len(a)
  while i < j {
    let t = a[i]
    a[i] = a[j]
    a[j] = t
    i += 1
    j -= 1
  }
  return a
}

print(reverse([1, 2, 3, 4, 5]))
`,
  },
  {
    id: 'search',
    title: 'Bug hunt: the endless search',
    hint: 'This binary search never finishes, so Rewind stops it. Scrub the timeline: watch lo, mid and hi. When do they stop changing?',
    code: `# Find the position of a number in a sorted list.
fn find(xs, target) {
  let lo = 0
  let hi = len(xs) - 1
  while lo <= hi {
    let mid = floor((lo + hi) / 2)
    if xs[mid] == target {
      return mid
    }
    if xs[mid] < target {
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  return -1
}

let primes = [2, 3, 5, 7, 11, 13, 17, 19, 23]
print("23 is at", find(primes, 23))
`,
  },
  {
    id: 'sort',
    title: 'Bubble sort',
    hint: 'Pick the list xs in the variables panel and scrub the timeline to watch it sort. Click any number in the final list to see which comparisons and swaps put it there.',
    code: `# Bubble sort: keep swapping neighbours that are out of order.
fn sort(a) {
  let n = len(a)
  for i in range(n) {
    for j in range(n - i - 1) {
      if a[j] > a[j + 1] {
        let t = a[j]
        a[j] = a[j + 1]
        a[j + 1] = t
      }
    }
  }
  return a
}

let xs = [29, 10, 14, 37, 13, 5]
sort(xs)
print(xs)
`,
  },
  {
    id: 'fib',
    title: 'Recursion: Fibonacci',
    hint: 'Watch the call stack grow and shrink as fib calls itself. Step over (Shift+→) runs a whole call at once; step out (↱) leaves one. Then click the printed line: 21 traces back through every call to a single origin, the 8 passed in.',
    code: `# Each Fibonacci number is the sum of the two before it.
fn fib(n) {
  if n < 2 {
    return n
  }
  return fib(n - 1) + fib(n - 2)
}

print("fib(8) =", fib(8))
`,
  },
  {
    id: 'sieve',
    title: 'Sieve of Eratosthenes',
    hint: 'Primes are what is left after crossing out multiples. Click a false in the sieve to see which prime crossed it out.',
    code: `# Find the primes below 40 by crossing out multiples.
let n = 40
let sieve = []
for i in range(n) {
  push(sieve, true)
}
sieve[0] = false
sieve[1] = false

let p = 2
while p * p < n {
  if sieve[p] {
    let m = p * p
    while m < n {
      sieve[m] = false
      m += p
    }
  }
  p += 1
}

let primes = []
for i in range(n) {
  if sieve[i] { push(primes, i) }
}
print(primes)
`,
  },
  {
    id: 'cart',
    title: 'Where did the discount come from?',
    hint: 'The total depends on prices, quantities and a discount rule. Ask why the total is what it is: data flows from the prices, and the discount exists only because of a condition.',
    code: `# A shopping basket with a bulk discount.
let prices = [4.5, 12, 3.25]
let qty = [2, 1, 4]

let total = 0
for i in range(len(prices)) {
  total += prices[i] * qty[i]
}

let items = 0
for q in qty { items += q }

if items >= 6 {
  total = total * 0.9
  print("bulk discount applied")
}
print("total:", total)
`,
  },
];
