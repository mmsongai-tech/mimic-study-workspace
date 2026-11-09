args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 3) stop("Expected scenario, output path, and figure path.")
scenario <- args[[1]]
output_path <- args[[2]]
figure_path <- args[[3]]
set.seed(20260901)

emit <- function(values) {
  lines <- vapply(names(values), function(key) paste(key, values[[key]], sep = "\t"), character(1))
  writeLines(lines, output_path, useBytes = TRUE)
}

n <- 600
age <- rnorm(n, 64, 13)
exposure <- rnorm(n)

if (scenario == "continuous_association") {
  outcome <- 0.8 * exposure + 0.03 * age + rnorm(n, 0, 1.2)
  fit <- lm(outcome ~ exposure + age)
  coefficient <- summary(fit)$coefficients["exposure", ]
  interval <- confint(fit, "exposure", level = 0.95)
  emit(list(method = "linear_regression", observations = n, study_units = n, events = 0,
    competing_events = 0, repeated_observations = 0, estimate = coefficient[["Estimate"]],
    ci_lower = interval[[1]], ci_upper = interval[[2]], p_value = coefficient[["Pr(>|t|)"]],
    converged = 1, residual_scale = sigma(fit), r_version = paste(R.version$major, R.version$minor, sep = ".")))
} else if (scenario == "count_association") {
  if (!requireNamespace("MASS", quietly = TRUE)) stop("MASS is required for negative-binomial validation.")
  outcome <- rnbinom(n, mu = exp(0.2 + 0.35 * exposure + 0.005 * age), size = 2)
  fit <- MASS::glm.nb(outcome ~ exposure + age)
  coefficient <- summary(fit)$coefficients["exposure", ]
  estimate <- exp(coefficient[["Estimate"]])
  interval <- exp(coefficient[["Estimate"]] + c(-1, 1) * 1.96 * coefficient[["Std. Error"]])
  emit(list(method = "negative_binomial_regression", observations = n, study_units = n, events = sum(outcome),
    competing_events = 0, repeated_observations = 0, estimate = estimate, ci_lower = interval[[1]],
    ci_upper = interval[[2]], p_value = coefficient[["Pr(>|z|)"]], converged = as.numeric(isTRUE(fit$converged)),
    residual_scale = summary(fit)$dispersion, r_version = paste(R.version$major, R.version$minor, sep = ".")))
} else if (scenario == "time_to_event_association") {
  if (!requireNamespace("survival", quietly = TRUE)) stop("survival is required for time-to-event validation.")
  event_time <- rexp(n, rate = 0.03 * exp(0.45 * exposure + 0.01 * (age - 64)))
  censor_time <- runif(n, 5, 60)
  time <- pmin(event_time, censor_time)
  event <- as.integer(event_time <= censor_time)
  fit <- survival::coxph(survival::Surv(time, event) ~ exposure + age, x = TRUE)
  coefficient <- summary(fit)$coefficients["exposure", ]
  interval <- summary(fit)$conf.int["exposure", c("lower .95", "upper .95")]
  emit(list(method = "cox_regression", observations = n, study_units = n, events = sum(event), competing_events = 0,
    repeated_observations = 0, estimate = exp(coefficient[["coef"]]), ci_lower = interval[[1]], ci_upper = interval[[2]],
    p_value = coefficient[["Pr(>|z|)"]], converged = as.numeric(all(is.finite(stats::coef(fit)))), residual_scale = 1,
    r_version = paste(R.version$major, R.version$minor, sep = ".")))
} else if (scenario == "repeated_measure_association") {
  if (!requireNamespace("nlme", quietly = TRUE)) stop("nlme is required for repeated-measure validation.")
  units <- 180
  visits <- 4
  id <- rep(seq_len(units), each = visits)
  time <- rep(0:(visits - 1), times = units)
  unit_exposure <- rnorm(units)
  repeated_exposure <- rep(unit_exposure, each = visits)
  random_intercept <- rep(rnorm(units, 0, 1), each = visits)
  outcome <- 1 + 0.7 * repeated_exposure + 0.25 * time + random_intercept + rnorm(units * visits, 0, 0.8)
  data <- data.frame(id = factor(id), time = time, exposure = repeated_exposure, outcome = outcome)
  fit <- nlme::lme(outcome ~ exposure + time, random = ~1 | id, data = data, method = "REML")
  coefficient <- summary(fit)$tTable["exposure", ]
  interval <- nlme::intervals(fit, level = 0.95)$fixed["exposure", c("lower", "upper")]
  emit(list(method = "linear_mixed_effects", observations = nrow(data), study_units = units, events = 0,
    competing_events = 0, repeated_observations = nrow(data), estimate = coefficient[["Value"]], ci_lower = interval[[1]],
    ci_upper = interval[[2]], p_value = coefficient[["p-value"]], converged = as.numeric(all(is.finite(nlme::fixef(fit)))), residual_scale = fit$sigma,
    r_version = paste(R.version$major, R.version$minor, sep = ".")))
} else if (scenario == "competing_risk_association") {
  if (!requireNamespace("survival", quietly = TRUE)) stop("survival is required for competing-risk validation.")
  event_time <- rexp(n, rate = 0.025 * exp(0.40 * exposure + 0.008 * (age - 64)))
  competing_time <- rexp(n, rate = 0.018 * exp(-0.10 * exposure))
  censor_time <- runif(n, 8, 70)
  time <- pmin(event_time, competing_time, censor_time)
  event_type <- ifelse(event_time <= competing_time & event_time <= censor_time, 1,
    ifelse(competing_time < event_time & competing_time <= censor_time, 2, 0))
  fit <- survival::coxph(survival::Surv(time, event_type == 1) ~ exposure + age, x = TRUE)
  coefficient <- summary(fit)$coefficients["exposure", ]
  interval <- summary(fit)$conf.int["exposure", c("lower .95", "upper .95")]
  emit(list(method = "cause_specific_cox", observations = n, study_units = n, events = sum(event_type == 1),
    competing_events = sum(event_type == 2), repeated_observations = 0, estimate = exp(coefficient[["coef"]]),
    ci_lower = interval[[1]], ci_upper = interval[[2]], p_value = coefficient[["Pr(>|z|)"]],
    converged = as.numeric(all(is.finite(stats::coef(fit)))), residual_scale = 1,
    r_version = paste(R.version$major, R.version$minor, sep = ".")))
} else {
  stop("Unsupported scenario.")
}

result_lines <- readLines(output_path, warn = FALSE)
result_parts <- strsplit(result_lines, "\t", fixed = TRUE)
result_values <- setNames(vapply(result_parts, function(item) item[[2]], character(1)), vapply(result_parts, function(item) item[[1]], character(1)))
estimate_value <- as.numeric(result_values[["estimate"]])
ci_lower_value <- as.numeric(result_values[["ci_lower"]])
ci_upper_value <- as.numeric(result_values[["ci_upper"]])
reference <- if (scenario %in% c("continuous_association", "repeated_measure_association")) 0 else 1
range_min <- min(ci_lower_value, reference)
range_max <- max(ci_upper_value, reference)
padding <- max((range_max - range_min) * 0.15, 0.1)
scale_x <- function(value) 120 + (value - (range_min - padding)) / ((range_max + padding) - (range_min - padding)) * 500
title <- gsub("_", " ", scenario)
svg_lines <- c(
  '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="260" viewBox="0 0 720 260" role="img" aria-labelledby="title desc">',
  sprintf('<title id="title">Synthetic validation estimate: %s</title>', title),
  '<desc id="desc">Point estimate and 95 percent confidence interval from deterministic synthetic R validation.</desc>',
  '<rect width="720" height="260" fill="white"/>',
  sprintf('<text x="360" y="38" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#18322c">%s</text>', title),
  sprintf('<line x1="%.2f" y1="70" x2="%.2f" y2="190" stroke="#9baba5" stroke-dasharray="5 5"/>', scale_x(reference), scale_x(reference)),
  sprintf('<line x1="%.2f" y1="125" x2="%.2f" y2="125" stroke="#0b7f65" stroke-width="5"/>', scale_x(ci_lower_value), scale_x(ci_upper_value)),
  sprintf('<circle cx="%.2f" cy="125" r="9" fill="#0b7f65"/>', scale_x(estimate_value)),
  sprintf('<text x="360" y="220" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#405a52">Estimate %.3f (95%% CI %.3f–%.3f)</text>', estimate_value, ci_lower_value, ci_upper_value),
  '</svg>'
)
writeLines(svg_lines, figure_path, useBytes = TRUE)
