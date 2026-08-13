---
name: design-critique
description: judging an interface — yours or an existing one
---
# design-critique

Critique the artefact, not the intention. Every point names the element, the
problem, and the fix.

1. **Hierarchy.** Squint at it. What do you see first? Is that the most
   important thing? If everything is emphasised, nothing is.
2. **Spacing before colour.** Most "ugly" is rhythm: inconsistent gaps,
   crowded edges, no relationship between related things. Space is the cheapest
   fix and almost always the right first one.
3. **Alignment.** How many invisible vertical lines are there? Fewer is better.
4. **Type.** Two families at most. Sizes from a scale, not chosen per element.
   Line length under ~75 characters. Line height that breathes.
5. **Colour.** One accent, used for one meaning. Check contrast for real — a
   translucent layer over a gradient is not the colour in your token file.
6. **States.** Hover, focus, active, disabled, loading, empty, error, too-long
   text, too-many items. The empty and error states are the ones always missing.
7. **Motion.** Does it explain a change, or decorate? Under 200ms for feedback.

End with the three changes with the largest effect, ranked. A list of twenty
equal-weight notes will not get acted on.
