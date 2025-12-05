# Improvement Plan (high → low priority)

- Prioritize blockers: sort issues so HIGH-severity blockers pin to top and are visually distinct from cautions. **[done]**
- Confidence UX: when doctor switches to non-PDE5 after blockers, auto-raise a post-review confidence (separate from initial) and display the cap reason plainly. **[done]**
- Structured meds input: capture meds as drug/dose/frequency fields (or chip list) and render them; improve parsing to reduce LLM ambiguity. **[done]**
- Vitals/lifestyle validation: require reasonable BP/BMI when HTN flagged; block implausible heights/weights; warn on missing vitals. **[done]**
- Lifestyle in risk: lightly penalize risk/score (not just dosing) for heavy alcohol/current smoking/sedentary; surface explicit issue text. **[done]**
- Audit clarity: show timestamps and concise risk/plan summary in audit entries; make the log collapsible/scrollable. **[done-basic]**
- Accessibility: add focus styles/ARIA labels for buttons, lists, and badges. **[done-basic]**
- CI: add a lightweight frontend lint or unit check (e.g., eslint or a smoke test) beyond `node --check`. **[done-basic eslint app.js]**
