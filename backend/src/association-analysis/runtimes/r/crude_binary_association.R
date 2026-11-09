args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 5) stop("Expected input, output, two figures, and threshold arguments.")

input_path <- args[[1]]
output_path <- args[[2]]
figure_path <- args[[3]]
sensitivity_figure_path <- args[[4]]
threshold <- suppressWarnings(as.numeric(args[[5]]))
if (!is.finite(threshold) || threshold <= 0) stop("Invalid threshold.")

records <- read.csv(input_path, stringsAsFactors = FALSE)
required <- c("subject_id", "max_lactate_first_6h", "in_hospital_death")
if (!all(required %in% names(records))) stop("Required columns are missing.")
if (is.character(records$in_hospital_death)) {
  normalized_outcome <- tolower(records$in_hospital_death)
  if (!all(normalized_outcome %in% c("true", "false"))) stop("Outcome values must be boolean.")
  records$in_hospital_death <- normalized_outcome == "true"
}
valid <- records[is.finite(records$max_lactate_first_6h) & !is.na(records$in_hospital_death), ]
exposed <- valid[valid$max_lactate_first_6h > threshold, ]
unexposed <- valid[valid$max_lactate_first_6h <= threshold, ]
if (nrow(exposed) == 0 || nrow(unexposed) == 0) stop("Both exposure groups require observations.")

exposed_events <- sum(exposed$in_hospital_death)
unexposed_events <- sum(unexposed$in_hospital_death)
cells <- c(exposed_events, nrow(exposed) - exposed_events, unexposed_events, nrow(unexposed) - unexposed_events)
correction <- if (any(cells == 0)) 0.5 else 0
a <- cells[[1]] + correction
b <- cells[[2]] + correction
c <- cells[[3]] + correction
d <- cells[[4]] + correction
odds_ratio <- (a * d) / (b * c)
standard_error <- sqrt(1 / a + 1 / b + 1 / c + 1 / d)
confidence_interval <- exp(log(odds_ratio) + c(-1, 1) * 1.96 * standard_error)
exposed_risk <- exposed_events / nrow(exposed)
unexposed_risk <- unexposed_events / nrow(unexposed)
valid$exposed <- as.integer(valid$max_lactate_first_6h > threshold)
valid$age_years <- suppressWarnings(as.numeric(valid$age_years))
valid$sex <- tolower(as.character(valid$sex))
complete <- valid[is.finite(valid$age_years) & valid$sex %in% c("female", "male"), ]
missing_records <- nrow(valid) - nrow(complete)
total_events <- sum(valid$in_hospital_death)
events_per_parameter <- total_events / 3

adjusted_status <- "not_estimable"
adjusted_reason <- "Age and sex require complete values, and the adjusted model requires variation in exposure and outcome."
adjusted_values <- numeric(0)
model_converged <- FALSE
maximum_vif <- NA_real_
if (nrow(complete) >= 20 && length(unique(complete$exposed)) == 2 && length(unique(complete$in_hospital_death)) == 2) {
  complete$sex_female <- as.integer(complete$sex == "female")
  fit <- suppressWarnings(glm(in_hospital_death ~ exposed + age_years + sex_female, data = complete, family = binomial()))
  coefficient <- summary(fit)$coefficients["exposed", ]
  if (isTRUE(fit$converged) && all(is.finite(coefficient))) {
    model_converged <- TRUE
    adjusted_status <- "completed"
    adjusted_reason <- ""
    adjusted_values <- c(
      adjusted_or = exp(coefficient[["Estimate"]]),
      adjusted_ci_lower = exp(coefficient[["Estimate"]] - 1.96 * coefficient[["Std. Error"]]),
      adjusted_ci_upper = exp(coefficient[["Estimate"]] + 1.96 * coefficient[["Std. Error"]]),
      adjusted_p_value = coefficient[["Pr(>|z|)"]]
    )
    matrix <- model.matrix(fit)[, -1, drop = FALSE]
    vif_values <- vapply(seq_len(ncol(matrix)), function(column) {
      response <- matrix[, column]
      predictors <- matrix[, -column, drop = FALSE]
      if (ncol(predictors) == 0 || var(response) == 0) return(1)
      r_squared <- summary(lm(response ~ predictors))$r.squared
      if (!is.finite(r_squared) || r_squared >= 1) return(Inf)
      1 / (1 - r_squared)
    }, numeric(1))
    maximum_vif <- max(vif_values)
  }
}

continuous_values <- numeric(0)
if (nrow(complete) >= 20 && length(unique(complete$in_hospital_death)) == 2) {
  complete$sex_female <- as.integer(complete$sex == "female")
  continuous_fit <- suppressWarnings(glm(in_hospital_death ~ max_lactate_first_6h + age_years + sex_female, data = complete, family = binomial()))
  continuous_coefficient <- summary(continuous_fit)$coefficients["max_lactate_first_6h", ]
  if (isTRUE(continuous_fit$converged) && all(is.finite(continuous_coefficient))) {
    continuous_values <- c(
      continuous_or = exp(continuous_coefficient[["Estimate"]]),
      continuous_ci_lower = exp(continuous_coefficient[["Estimate"]] - 1.96 * continuous_coefficient[["Std. Error"]]),
      continuous_ci_upper = exp(continuous_coefficient[["Estimate"]] + 1.96 * continuous_coefficient[["Std. Error"]]),
      continuous_p_value = continuous_coefficient[["Pr(>|z|)"]]
    )
  }
}

threshold_estimate <- function(cutoff) {
  high <- valid[valid$max_lactate_first_6h > cutoff, ]
  low <- valid[valid$max_lactate_first_6h <= cutoff, ]
  if (nrow(high) == 0 || nrow(low) == 0) return(rep(NA_real_, 5))
  high_events <- sum(high$in_hospital_death)
  low_events <- sum(low$in_hospital_death)
  sensitivity_cells <- c(high_events, nrow(high) - high_events, low_events, nrow(low) - low_events)
  sensitivity_correction <- if (any(sensitivity_cells == 0)) 0.5 else 0
  sa <- sensitivity_cells[[1]] + sensitivity_correction
  sb <- sensitivity_cells[[2]] + sensitivity_correction
  sc <- sensitivity_cells[[3]] + sensitivity_correction
  sd <- sensitivity_cells[[4]] + sensitivity_correction
  estimate <- (sa * sd) / (sb * sc)
  se <- sqrt(1 / sa + 1 / sb + 1 / sc + 1 / sd)
  interval <- exp(log(estimate) + c(-1, 1) * 1.96 * se)
  c(nrow(high), nrow(low), estimate, interval[[1]], interval[[2]])
}
sensitivity_thresholds <- sort(unique(pmax(0.1, c(threshold - 0.5, threshold, threshold + 0.5))))
sensitivity_results <- t(vapply(sensitivity_thresholds, threshold_estimate, numeric(5)))

format_mean_sd <- function(values) {
  values <- values[is.finite(values)]
  if (length(values) < 2) return("Not available")
  sprintf("%.1f (%.1f)", mean(values), sd(values))
}
format_median_iqr <- function(values) {
  values <- values[is.finite(values)]
  if (length(values) == 0) return("Not available")
  quartiles <- quantile(values, c(0.25, 0.75), names = FALSE)
  sprintf("%.1f (%.1f-%.1f)", median(values), quartiles[[1]], quartiles[[2]])
}
format_count_percent <- function(condition, denominator) {
  if (denominator == 0) return("Not available")
  count <- sum(condition, na.rm = TRUE)
  sprintf("%d (%.1f%%)", count, 100 * count / denominator)
}
group_summary <- function(data) c(
  n = as.character(nrow(data)),
  age = format_mean_sd(data$age_years),
  female = format_count_percent(data$sex == "female", nrow(data)),
  lactate = format_median_iqr(data$max_lactate_first_6h),
  death = format_count_percent(data$in_hospital_death, nrow(data))
)
table_total <- group_summary(valid)
table_exposed <- group_summary(exposed)
table_unexposed <- group_summary(unexposed)

values <- c(
  total = nrow(valid), exposed = nrow(exposed), unexposed = nrow(unexposed),
  exposed_events = exposed_events, unexposed_events = unexposed_events,
  exposed_risk = exposed_risk, unexposed_risk = unexposed_risk,
  risk_difference = exposed_risk - unexposed_risk, odds_ratio = odds_ratio,
  ci_lower = confidence_interval[[1]], ci_upper = confidence_interval[[2]],
  complete_cases = nrow(complete), missing_records = missing_records,
  total_events = total_events, events_per_parameter = events_per_parameter
)
diagnostic_values <- c(
  model_converged = as.numeric(model_converged),
  maximum_vif = if (is.finite(maximum_vif)) maximum_vif else -1,
  confidence_interval_width_ratio = confidence_interval[[2]] / confidence_interval[[1]],
  sparse_data_warning = as.numeric(any(cells < 5) || events_per_parameter < 10)
)
sensitivity_lines <- unlist(lapply(seq_along(sensitivity_thresholds), function(index) {
  result <- sensitivity_results[index, ]
  keys <- c("threshold", "exposed", "unexposed", "or", "ci_lower", "ci_upper")
  numbers <- c(sensitivity_thresholds[[index]], result)
  paste(sprintf("sensitivity_%d_%s", index, keys), format(numbers, digits = 17, scientific = FALSE, trim = TRUE), sep = "\t")
}))
output_lines <- c(
  paste(names(values), format(values, digits = 17, scientific = FALSE, trim = TRUE), sep = "\t"),
  paste(names(diagnostic_values), format(diagnostic_values, digits = 17, scientific = FALSE, trim = TRUE), sep = "\t"),
  if (length(adjusted_values)) paste(names(adjusted_values), format(adjusted_values, digits = 17, scientific = FALSE, trim = TRUE), sep = "\t") else character(0),
  if (length(continuous_values)) paste(names(continuous_values), format(continuous_values, digits = 17, scientific = FALSE, trim = TRUE), sep = "\t") else character(0),
  sensitivity_lines,
  paste("sensitivity_count", length(sensitivity_thresholds), sep = "\t"),
  paste("adjusted_model_status", adjusted_status, sep = "\t"),
  paste("adjusted_model_reason", adjusted_reason, sep = "\t"),
  paste("table_total_n", table_total[["n"]], sep = "\t"),
  paste("table_exposed_n", table_exposed[["n"]], sep = "\t"),
  paste("table_unexposed_n", table_unexposed[["n"]], sep = "\t"),
  paste("table_total_age", table_total[["age"]], sep = "\t"),
  paste("table_exposed_age", table_exposed[["age"]], sep = "\t"),
  paste("table_unexposed_age", table_unexposed[["age"]], sep = "\t"),
  paste("table_total_female", table_total[["female"]], sep = "\t"),
  paste("table_exposed_female", table_exposed[["female"]], sep = "\t"),
  paste("table_unexposed_female", table_unexposed[["female"]], sep = "\t"),
  paste("table_total_lactate", table_total[["lactate"]], sep = "\t"),
  paste("table_exposed_lactate", table_exposed[["lactate"]], sep = "\t"),
  paste("table_unexposed_lactate", table_unexposed[["lactate"]], sep = "\t"),
  paste("table_total_death", table_total[["death"]], sep = "\t"),
  paste("table_exposed_death", table_exposed[["death"]], sep = "\t"),
  paste("table_unexposed_death", table_unexposed[["death"]], sep = "\t"),
  paste("r_version", paste(R.version$major, R.version$minor, sep = "."), sep = "\t")
)
writeLines(output_lines, output_path, useBytes = TRUE)

plot_height <- 220
baseline <- 285
exposed_bar_height <- exposed_risk * plot_height
unexposed_bar_height <- unexposed_risk * plot_height
svg_lines <- c(
  '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="420" viewBox="0 0 700 420" role="img" aria-labelledby="title desc">',
  '<title id="title">In-hospital mortality risk by exposure group</title>',
  '<desc id="desc">Aggregate risk comparison generated by the registered R statistical executor.</desc>',
  '<rect width="700" height="420" fill="white"/>',
  '<text x="350" y="35" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#18322c">In-hospital mortality risk</text>',
  '<line x1="100" y1="285" x2="620" y2="285" stroke="#789087"/>',
  '<line x1="100" y1="65" x2="100" y2="285" stroke="#789087"/>',
  sprintf('<rect x="190" y="%.3f" width="120" height="%.3f" fill="#0b7f65"/>', baseline - exposed_bar_height, exposed_bar_height),
  sprintf('<rect x="410" y="%.3f" width="120" height="%.3f" fill="#9bcfbe"/>', baseline - unexposed_bar_height, unexposed_bar_height),
  sprintf('<text x="250" y="%.3f" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#18322c">%.1f%%</text>', baseline - exposed_bar_height - 10, exposed_risk * 100),
  sprintf('<text x="470" y="%.3f" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#18322c">%.1f%%</text>', baseline - unexposed_bar_height - 10, unexposed_risk * 100),
  '<text x="250" y="320" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#18322c">Exposed</text>',
  '<text x="470" y="320" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#18322c">Unexposed</text>',
  sprintf('<text x="350" y="370" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#60756d">Threshold: %.2f mmol/L · synthetic data</text>', threshold),
  '</svg>'
)
writeLines(svg_lines, figure_path, useBytes = TRUE)

forest_y <- seq(80, by = 75, length.out = length(sensitivity_thresholds))
log_min <- min(log(sensitivity_results[, 4]), na.rm = TRUE)
log_max <- max(log(sensitivity_results[, 5]), na.rm = TRUE)
scale_x <- function(value) 190 + (log(value) - log_min) / (log_max - log_min) * 430
forest_lines <- c(
  '<svg xmlns="http://www.w3.org/2000/svg" width="700" height="360" viewBox="0 0 700 360" role="img" aria-labelledby="title desc">',
  '<title id="title">Threshold sensitivity analysis</title>',
  '<desc id="desc">Odds ratios and 95 percent confidence intervals across lactate thresholds.</desc>',
  '<rect width="700" height="360" fill="white"/>',
  '<text x="350" y="32" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#18322c">Threshold sensitivity analysis</text>',
  sprintf('<line x1="%.2f" y1="55" x2="%.2f" y2="300" stroke="#9baba5" stroke-dasharray="4 4"/>', scale_x(1), scale_x(1)),
  unlist(lapply(seq_along(sensitivity_thresholds), function(index) c(
    sprintf('<text x="25" y="%.2f" font-family="sans-serif" font-size="14" fill="#18322c">&gt; %.1f mmol/L</text>', forest_y[[index]] + 5, sensitivity_thresholds[[index]]),
    sprintf('<line x1="%.2f" y1="%.2f" x2="%.2f" y2="%.2f" stroke="#0b7f65" stroke-width="3"/>', scale_x(sensitivity_results[index, 4]), forest_y[[index]], scale_x(sensitivity_results[index, 5]), forest_y[[index]]),
    sprintf('<circle cx="%.2f" cy="%.2f" r="6" fill="#0b7f65"/>', scale_x(sensitivity_results[index, 3]), forest_y[[index]])
  ))),
  '<text x="405" y="335" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#60756d">Odds ratio (log scale)</text>',
  '</svg>'
)
writeLines(forest_lines, sensitivity_figure_path, useBytes = TRUE)
