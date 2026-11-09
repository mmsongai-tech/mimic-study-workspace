# Representative cases — study-frame-extraction-en 1.0.0

English questions only; the Chinese prompt `study-frame-extraction` is used for questions containing Chinese.
Measured on qwen2.5:7b-instruct-q4_K_M, temperature 0, 2026-09-27. With the Chinese-example prompt the same model
translated the phrases of 2 of 3 English questions into Chinese and dropped the disease (for example
"patients admitted with diabetic ketoacidosis" became "患者").

| Question | Expected population / exposure / outcome | Result |
|---|---|---|
| What is the in-hospital mortality of patients admitted with diabetic ketoacidosis, by age group? | patients admitted with diabetic ketoacidosis / age group / in-hospital mortality | copied |
| Does the effect of norepinephrine on mortality in septic shock differ by age? | septic shock / norepinephrine / mortality, modifier age | copied |
| Is early hydrocortisone associated with lower 28-day mortality in patients with sepsis? | patients with sepsis / early hydrocortisone / 28-day mortality | copied |
| Among ICU patients with acute kidney injury, does continuous renal replacement therapy reduce 90-day mortality? | ICU patients with acute kidney injury / continuous renal replacement therapy / 90-day mortality | copied |
