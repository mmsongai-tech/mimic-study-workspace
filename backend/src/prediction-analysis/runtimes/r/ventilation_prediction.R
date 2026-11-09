args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 4) stop("expected input, output, ROC figure, calibration figure")
data <- read.csv(args[[1]], stringsAsFactors = FALSE)
required <- c("subject_id", "age_years", "respiratory_rate", "spo2_fio2_ratio", "gcs", "outcome")
if (!all(required %in% names(data))) stop("missing required columns")
complete <- complete.cases(data[, required])
d <- data[complete, ]
if (nrow(d) < 100 || length(unique(d$outcome)) != 2) stop("insufficient prediction data")
validation <- seq_len(nrow(d)) %% 10 %in% c(0, 3, 7)
development <- d[!validation, ]
test <- d[validation, ]
model <- glm(outcome ~ age_years + respiratory_rate + spo2_fio2_ratio + gcs, data = development, family = binomial())
probability <- predict(model, newdata = test, type = "response")
outcome <- test$outcome
auc <- function(y, p) {
  positive <- p[y == 1]; negative <- p[y == 0]
  mean(outer(positive, negative, ">") + 0.5 * outer(positive, negative, "=="))
}
auroc <- auc(outcome, probability)
brier <- mean((outcome - probability)^2)
development_probability <- predict(model, newdata = development, type = "response")
candidate_thresholds <- sort(unique(development_probability))
youden <- sapply(candidate_thresholds, function(x) {
  predicted_development <- development_probability >= x
  sensitivity_development <- sum(predicted_development & development$outcome == 1) / sum(development$outcome == 1)
  specificity_development <- sum(!predicted_development & development$outcome == 0) / sum(development$outcome == 0)
  sensitivity_development + specificity_development - 1
})
probability_threshold <- candidate_thresholds[[which.max(youden)]]
predicted <- probability >= probability_threshold
sensitivity <- sum(predicted & outcome == 1) / sum(outcome == 1)
specificity <- sum(!predicted & outcome == 0) / sum(outcome == 0)
clipped <- pmin(pmax(probability, 1e-6), 1 - 1e-6)
calibration <- glm(outcome ~ qlogis(clipped), family = binomial())
writeLines(c(
  paste("r_version", paste(R.version$major, R.version$minor, sep = "."), sep = "\t"),
  paste("total", nrow(d), sep = "\t"), paste("development", nrow(development), sep = "\t"),
  paste("validation", nrow(test), sep = "\t"), paste("validation_events", sum(outcome), sep = "\t"),
  paste("missing_records", nrow(data) - nrow(d), sep = "\t"), paste("auroc", auroc, sep = "\t"),
  paste("brier", brier, sep = "\t"), paste("calibration_intercept", coef(calibration)[[1]], sep = "\t"),
  paste("calibration_slope", coef(calibration)[[2]], sep = "\t"), paste("sensitivity", sensitivity, sep = "\t"),
  paste("specificity", specificity, sep = "\t"), paste("probability_threshold", probability_threshold, sep = "\t"), paste("converged", as.integer(model$converged), sep = "\t"),
  paste("events_per_parameter", sum(development$outcome) / length(coef(model)), sep = "\t"),
  paste("coefficient_age", coef(model)[["age_years"]], sep = "\t"),
  paste("coefficient_rr", coef(model)[["respiratory_rate"]], sep = "\t"),
  paste("coefficient_ratio", coef(model)[["spo2_fio2_ratio"]], sep = "\t"),
  paste("coefficient_gcs", coef(model)[["gcs"]], sep = "\t")
), args[[2]])
thresholds <- sort(unique(probability))
tpr <- sapply(thresholds, function(x) sum(probability >= x & outcome == 1) / sum(outcome == 1))
fpr <- sapply(thresholds, function(x) sum(probability >= x & outcome == 0) / sum(outcome == 0))
points <- paste(sprintf("%.1f,%.1f", 70 + 560 * fpr, 320 - 250 * tpr), collapse = " ")
roc <- paste0('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="380"><rect width="700" height="380" fill="white"/><text x="350" y="35" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#173b33">ROC curve · 24-hour ventilation</text><line x1="70" y1="320" x2="630" y2="70" stroke="#aaa" stroke-dasharray="6"/><polyline points="', points, '" fill="none" stroke="#0b806a" stroke-width="5"/><text x="350" y="360" text-anchor="middle" font-family="sans-serif" font-size="16">AUROC ', sprintf("%.3f", auroc), '</text></svg>')
writeLines(roc, args[[3]])
groups <- cut(probability, breaks = unique(quantile(probability, probs = seq(0, 1, 0.2))), include.lowest = TRUE)
cal <- aggregate(cbind(predicted = probability, observed = outcome), list(group = groups), mean)
circles <- paste(mapply(function(p, o) sprintf('<circle cx="%.1f" cy="%.1f" r="8" fill="#0b806a"/>', 70 + 560*p, 320 - 250*o), cal$predicted, cal$observed), collapse = "")
calibration_svg <- paste0('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="380"><rect width="700" height="380" fill="white"/><text x="350" y="35" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#173b33">Calibration plot</text><line x1="70" y1="320" x2="630" y2="70" stroke="#c79020" stroke-width="3"/>', circles, '</svg>')
writeLines(calibration_svg, args[[4]])
