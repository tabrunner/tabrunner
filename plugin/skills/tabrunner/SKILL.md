---
name: tabrunner
description: Hand browser work to TabRunner, the agent that runs in the user's own Chrome with the accounts they're signed in to. Use when a task needs a real, signed-in browser (read a dashboard, fill a form, check an order, use a site that has no API) or when the user says "in my browser" or names TabRunner. Needs the TabRunner extension with the bridge turned on in Settings → MCP.
---

# TabRunner

TabRunner is a browser agent in the user's own Chrome. It works in their tabs and on the sites
they're signed in to, plans with the model they picked in the extension, and asks the user before
it pays, sends or deletes anything.

## Call `health` first

`health` says whether the extension is connected, which model it will use, and what to fix when
something is missing. If it isn't ready, tell the user what `health` said and stop there. Calling
it again won't fix the setup.

## Anything long or open-ended: `run`

`run(task)` hands TabRunner the whole job and returns at once. Browser work takes minutes.

- Write the task the way you'd brief a person: the goal, the site, and what to bring back. Pass
  `url` to start on a given page. The task opens its own tab and leaves the user's page alone.
- Follow it with `get_status`. It waits until something changes, so call it again after each
  answer. Don't sleep or poll in between.
- When the run stops on a question, reply with `answer(text)`. If the choice is the user's, ask
  the user first.
- `steer(text)` adds a correction while the task runs. `stop()` ends it. Stopping is normal, not
  an error.
- A second `run` while one is going waits in line and tells you its place.
- `screenshot()` shows what the browser shows right now.

## Small, exact jobs: the `browser_*` tools

When you know exactly what to click, drive a tab yourself:

1. `browser_start(goal, url)` opens a tab and returns the page with a `ref` on each element.
2. Act with `browser_click(ref)`, `browser_fill(ref, text)`, `browser_type`, `browser_press_key`,
   `browser_navigate` and `browser_scroll`. `browser_snapshot` reads the page again.
3. Call `browser_end()` when you're done, so the user gets the browser back.

These skip TabRunner's model, and with it the rule about asking first. Before anything that pays,
sends, deletes or posts, ask the user yourself.

## Keep in mind

- Everything happens in the user's real accounts. Treat each action as if the user did it.
- Every run and every direct session lands in the user's TabRunner history, under your client's
  name.
- `new_conversation()` starts a fresh thread. `compact()` shortens a long one.
