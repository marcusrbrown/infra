# Run issues facet prompt

The prompt of the custom Topics facet **Run issues**. It replaces the built-in **Issues** facet on the Topics rule. The text below is the built-in Issues prompt as this project stored it (facet version 1), unchanged except for one added rule (the line that starts "When the run's job is to review or audit other work"). Built-in facet prompts cannot be edited, so the facet is a custom one, made through the procedure in [Topics, step 9](../../../docs/runbooks/trace-collection.md#topics). Paste the text between the fences exactly; the `prompt` field takes at most 4,000 characters, and this is 3983.

```text
Describe the problem that did the most damage to the result of this run: the mistake that made the final answer or action wrong, unsupported, or missing.

Format: one sentence shaped "<what went wrong> in <kind of step>, so <consequence>", for example "Answered from memory instead of using the lookup result in the final answer, so the reported value is unsupported."
- What went wrong: name the mechanism in generic words, such as answered without support, invented data, misread a tool result, used the wrong tool, passed a wrong argument, skipped a required step, stopped before finishing, ignored an instruction, broke the required format, or claimed an action that did not happen.
- Kind of step: use a generic kind, such as a tool call, a search, a file read, a file edit, a code change, a calculation, an account or booking action, a clarification, or the final answer.
- Consequence: what this did to the result in generic words (wrong, unsupported, incomplete, or missing).
- Never name the task's subject or domain: no products, places, organizations, software projects, file names, commands, or topics.
- Do not start with a label or category.

Decide in this order:
1. Find the result: the final answer the user received, or the final action the run took (an edit, a booking, a submitted change). If the run ends with no answer and no action although the request needed one, the issue is the missing result.
2. Check the result against the request. It is wrong if it states something the run's own tool results or the user contradict, answers a different question, quantity or entity, or claims an action that did not happen. It is incomplete if a required part of the request is missing. It is unsupported only if it states a run-specific fact that no tool result or user input in this run provides. It is also wrong if it breaks a required output format or an explicit instruction from the system prompt or the user.
3. If the result is right, complete and supported, return not_applicable, even when earlier steps failed and were recovered, an optional check was skipped, or the path was clumsy.
4. If the result is wrong, incomplete or unsupported, work back to the step that caused it and report that cause with its consequence. When several problems contributed, report the one with the biggest effect.

- When the run's job is to review or audit other work (a pull request, a change, a document, a deployment), the defects it reports are its output, not its issues. Judge the review itself: whether it missed a defect the inputs show, reported one the inputs contradict, misread a file or tool result, skipped a required check, or broke the required verdict format. A review that correctly reports problems in the work it reviewed is not_applicable.
- Only problems in this run count; an error the user pastes for explanation or a problem in earlier conversation is not an issue here.
- A clarifying question, a justified refusal, a short answer, and an honest statement that a requested capability is not available are not issues. A capability gap is an issue only when the run mishandled it: it tried anyway and presented a wrong or partial result as complete, failed without telling the user, or claimed something is not possible that the run shows is possible.
- When the result is supported but you cannot tell whether it is right, return not_applicable.

Status: not_applicable when the run is complete enough to judge and its result is right, complete and supported. insufficient_input when too much is missing to judge, for example only the first request survives.

Examples:
- Invented data in the final answer after a failed file read, so the reported result is unsupported.
- Answered a different quantity than requested in the final answer, so the result is wrong.
- Claimed an edit that did not happen in the final answer, so the reported change is wrong.
- Stopped after repeated failures in a tool call without a fallback, so the result is missing.
```
