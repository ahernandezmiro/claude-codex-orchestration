Return a YAML report with these keys:

```yaml
verdict: acceptable | revise | rethink
critical_findings: []
important_findings: []
minor_findings: []
alternatives:
  - name: ...
    tradeoffs: ...
recommended_questions_for_author: []
```

If you cannot complete the review, set the verdict you can support and list what is missing in `recommended_questions_for_author`.
