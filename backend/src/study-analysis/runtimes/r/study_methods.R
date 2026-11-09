#!/usr/bin/env Rscript
# Fixed, versioned statistical methods for framed MIMIC-IV studies.
# Usage: Rscript study_methods.R <analysis.csv> <config.json> <output_dir>
# Input rows are one analysis unit each. Standard columns: exposure, outcome, time, event;
# covariate, modifier, mediator and predictor columns are named in the config.
# Output: <output_dir>/result.json and PNG figures. Only aggregate results are written.

METHOD_LIBRARY_VERSION <- "1.3.0"

suppressPackageStartupMessages({
  library(jsonlite)
  library(survival)
  library(splines)
})

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0 || (length(a) == 1 && is.na(a))) b else a

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 3) stop("Usage: study_methods.R <analysis.csv> <config.json> <output_dir>")
cfg <- fromJSON(args[2], simplifyVector = TRUE)
out_dir <- args[3]
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
set.seed(cfg$seed %||% 20260924)
alpha <- cfg$alpha %||% 0.05
z <- qnorm(1 - alpha / 2)
small_cell <- cfg$small_cell_threshold %||% 10

result <- list(
  method_id = cfg$method_id, method_library_version = METHOD_LIBRARY_VERSION, status = "completed",
  n_input = NA, n_analysed = NA, estimates = list(), diagnostics = setNames(list(), character()), warnings = character(),
  tables = list(), figures = list()
)
warn <- function(message) result$warnings <<- c(result$warnings, message)
add_estimate <- function(term, measure, estimate, low = NA, high = NA, p = NA, label = term) {
  result$estimates[[length(result$estimates) + 1]] <<- list(
    term = term, label = label, measure = measure, estimate = unname(estimate),
    ci_low = unname(low), ci_high = unname(high), p_value = unname(p)
  )
}
add_figure <- function(file, title, kind) {
  result$figures[[length(result$figures) + 1]] <<- list(file = file, title = title, kind = kind)
}
label_of <- function(column) {
  labels <- cfg$labels %||% list()
  if (!is.null(labels[[column]])) labels[[column]] else column
}
png_open <- function(file, width = 1400, height = 1000) {
  png(file.path(out_dir, file), width = width, height = height, res = 180)
  par(mar = c(4.5, 4.5, 3, 1.5))
}

# ---------- data preparation ----------
d <- read.csv(args[1], stringsAsFactors = FALSE, check.names = FALSE)
result$n_input <- nrow(d)
as_binary <- function(x) {
  if (is.logical(x)) return(as.integer(x))
  v <- tolower(trimws(as.character(x)))
  out <- rep(NA_integer_, length(v))
  out[v %in% c("true", "1", "yes", "t")] <- 1L
  out[v %in% c("false", "0", "no", "f")] <- 0L
  out
}
is_binary_like <- function(x) {
  v <- unique(tolower(trimws(as.character(x[!is.na(x) & x != ""]))))
  length(v) > 0 && all(v %in% c("true", "false", "0", "1", "yes", "no", "t", "f"))
}
prepare <- function(x) {
  if (is_binary_like(x)) return(as_binary(x))
  num <- suppressWarnings(as.numeric(x))
  if (sum(!is.na(num)) >= 0.9 * sum(!is.na(x) & x != "")) return(num)
  f <- as.character(x); f[f == ""] <- NA
  factor(f)
}
covariates <- cfg$covariates %||% character()
modifier <- cfg$modifier %||% NULL
mediator <- cfg$mediator %||% NULL
predictors <- cfg$predictors %||% character()
characteristics <- cfg$characteristics %||% character()
outcome_type <- cfg$outcome_type %||% "binary"
# A description fits no model: every row is kept, each variable is described where it is recorded, and nothing is dropped as constant.
describing <- startsWith(cfg$method_id %||% "", "descriptive.")
needed <- unique(c(intersect(c("exposure", "outcome", "time", "event"), names(d)), covariates, modifier, mediator, predictors, characteristics))
missing_cols <- setdiff(c(covariates, modifier, mediator, predictors, characteristics), names(d))
if (length(missing_cols)) warn(paste0("Columns not present in the dataset were ignored: ", paste(missing_cols, collapse = ", ")))
needed <- intersect(needed, names(d))
for (column in needed) d[[column]] <- prepare(d[[column]])
covariates <- intersect(covariates, names(d))
predictors <- intersect(predictors, names(d))
characteristics <- intersect(characteristics, names(d))
if (!is.null(modifier) && !(modifier %in% names(d))) modifier <- NULL
if (!is.null(mediator) && !(mediator %in% names(d))) mediator <- NULL
# Constant covariates cannot be estimated and are dropped with a warning.
constant <- if (describing) character() else covariates[vapply(covariates, function(column) length(unique(na.omit(d[[column]]))) < 2, logical(1))]
if (length(constant)) { warn(paste0("Constant covariates were dropped: ", paste(constant, collapse = ", "))); covariates <- setdiff(covariates, constant) }
model_columns <- if (describing) character() else intersect(unique(c("exposure", if (outcome_type == "time_to_event") c("time", "event") else "outcome", covariates, modifier, mediator, predictors)), names(d))
d_all <- d  # rows before the complete-case restriction, kept for the missing-data comparison of prediction models
complete <- if (length(model_columns)) complete.cases(d[, model_columns, drop = FALSE]) else rep(TRUE, nrow(d))
if (sum(!complete) > 0) warn(sprintf("%d of %d rows with missing model variables were excluded (complete-case analysis).", sum(!complete), nrow(d)))
d <- d[complete, , drop = FALSE]
result$n_analysed <- nrow(d)
if (nrow(d) < 20) stop("Fewer than 20 complete analysis rows.")

exposure_binary <- "exposure" %in% names(d) && is.numeric(d$exposure) && all(d$exposure %in% c(0, 1))
suppress <- function(n) if (!is.na(n) && n > 0 && n < small_cell) paste0("<", small_cell) else as.character(n)
rhs <- function(terms) if (length(terms)) paste(terms, collapse = " + ") else "1"

# ---------- descriptive tables ----------
smd <- function(x, g, w = NULL) {
  if (is.null(w)) w <- rep(1, length(x))
  if (is.factor(x)) {
    return(max(vapply(levels(x), function(level) smd(as.integer(x == level), g, w), numeric(1))))
  }
  m1 <- weighted.mean(x[g == 1], w[g == 1]); m0 <- weighted.mean(x[g == 0], w[g == 0])
  v1 <- sum(w[g == 1] * (x[g == 1] - m1)^2) / sum(w[g == 1]); v0 <- sum(w[g == 0] * (x[g == 0] - m0)^2) / sum(w[g == 0])
  denom <- sqrt((v1 + v0) / 2)
  if (!is.finite(denom) || denom == 0) return(0)
  abs(m1 - m0) / denom
}
describe <- function(x, rows) {
  x <- x[rows]
  if (is.factor(x)) {
    return(paste(vapply(levels(x), function(level) { n <- sum(x == level); sprintf("%s: %s (%.1f%%)", level, suppress(n), 100 * n / length(x)) }, character(1)), collapse = "; "))
  }
  if (all(x %in% c(0, 1))) { n <- sum(x == 1); return(sprintf("%s (%.1f%%)", suppress(n), 100 * n / length(x))) }
  q <- quantile(x, c(0.25, 0.5, 0.75))
  sprintf("%.2f (%.2f); %.2f [%.2f, %.2f]", mean(x), sd(x), q[2], q[1], q[3])
}
# ---------- description: Table 1 and each characteristic, overall and by the grouping ----------
# The grouping is the exposure column: yes/no (a drug received or not) or its recorded levels (sex, age bands). A row without a
# grouping value is described overall only.
group_of <- if (describing && "exposure" %in% names(d)) {
  x <- d$exposure
  if (is.numeric(x) && length(na.omit(x)) && all(na.omit(x) %in% c(0, 1))) ifelse(is.na(x), NA_character_, ifelse(x == 1, "yes", "no")) else ifelse(is.na(x), NA_character_, as.character(x))
} else NULL
group_levels <- if (is.null(group_of)) character() else { present <- unique(na.omit(group_of)); if (all(present %in% c("yes", "no"))) intersect(c("yes", "no"), present) else sort(present) }
group_key <- function(level) if (all(group_levels %in% c("yes", "no"))) (if (level == "yes") "exposed" else "unexposed") else paste0(label_of("exposure"), " = ", level)
in_group <- function(level) !is.na(group_of) & group_of == level
describe_available <- function(x) {
  x <- x[!is.na(x)]
  if (!length(x)) return("-")
  if (is.factor(x)) {
    x <- droplevels(x)
    return(paste(vapply(levels(x), function(level) { n <- sum(x == level); sprintf("%s: %s (%.1f%%)", level, suppress(n), 100 * n / length(x)) }, character(1)), collapse = "; "))
  }
  if (all(x %in% c(0, 1))) { n <- sum(x == 1); return(sprintf("%s (%.1f%%)", suppress(n), 100 * n / length(x))) }
  q <- quantile(x, c(0.25, 0.5, 0.75))
  sprintf("%.2f (%.2f); %.2f [%.2f, %.2f]", mean(x), if (length(x) > 1) sd(x) else 0, q[2], q[1], q[3])
}
table_one_described <- function() {
  columns <- intersect(unique(c(covariates, characteristics)), names(d))
  rows <- lapply(columns, function(column) {
    x <- d[[column]]
    row <- list(variable = label_of(column), overall = describe_available(x))
    for (level in group_levels) row[[group_key(level)]] <- describe_available(x[in_group(level)])
    row$missing <- suppress(sum(is.na(x)))
    row
  })
  header <- list(variable = "N", overall = as.character(nrow(d)))
  for (level in group_levels) header[[group_key(level)]] <- suppress(sum(in_group(level)))
  header$missing <- if (is.null(group_of)) "-" else suppress(sum(is.na(group_of)))
  result$tables$table1 <<- c(list(header), rows)
}
# A proportion with its exact (Clopper-Pearson) interval, or a mean with its t interval, among the rows where the value is recorded.
describe_estimate <- function(column, rows, level = NULL, label = label_of(column)) {
  x <- d[[column]][rows]; x <- x[!is.na(x)]
  if (!length(x)) return(invisible(NULL))
  where <- if (is.null(level)) " (overall)" else paste0(" in ", label_of("exposure"), " = ", level)
  term <- function(base) if (is.null(level)) base else paste0(base, ":", level)
  if (is.factor(x)) {
    x <- droplevels(x)
    for (value in levels(x)) { k <- sum(x == value); ci <- stats::binom.test(k, length(x))$conf.int
      add_estimate(term(paste0(column, "=", value)), "proportion", k / length(x), ci[1], ci[2], NA, paste0(label, ": ", value, where)) }
  } else if (all(x %in% c(0, 1))) {
    k <- sum(x == 1); ci <- stats::binom.test(k, length(x))$conf.int
    add_estimate(term(column), "proportion", k / length(x), ci[1], ci[2], NA, paste0(label, where))
  } else if (length(x) >= 2) {
    ci <- if (sd(x) > 0) stats::t.test(x)$conf.int else c(mean(x), mean(x))
    add_estimate(term(column), "mean", mean(x), ci[1], ci[2], NA, paste0(label, where))
  }
}
# An unadjusted test of each characteristic between the groups: chi-square (Fisher for small cells) or a rank test.
describe_test <- function(column) {
  rows <- !is.na(group_of) & !is.na(d[[column]]); x <- d[[column]][rows]; g <- factor(group_of[rows])
  if (length(unique(g)) < 2 || length(unique(x)) < 2) return(invisible(NULL))
  test <- tryCatch(if (is.factor(x) || all(x %in% c(0, 1))) { tab <- table(g, x); if (any(suppressWarnings(chisq.test(tab)$expected) < 5)) fisher.test(tab, simulate.p.value = nlevels(g) > 2 || ncol(tab) > 2) else chisq.test(tab) } else if (nlevels(g) == 2) wilcox.test(x ~ g) else kruskal.test(x ~ g), error = function(e) NULL)
  if (!is.null(test)) add_estimate(paste0("test:", column), "test_statistic", unname(test$statistic %||% NA), NA, NA, test$p.value, paste0(label_of(column), ": difference between groups (", test$method, ")"))
}

table_one <- function() {
  if (describing) return(table_one_described())
  columns <- intersect(unique(c(covariates, modifier, mediator, predictors, if (outcome_type != "time_to_event") "outcome")), names(d))
  if (!exposure_binary) columns <- unique(c(if ("exposure" %in% names(d)) "exposure", columns))
  rows <- lapply(columns, function(column) {
    row <- list(variable = label_of(column), overall = describe(d[[column]], rep(TRUE, nrow(d))))
    if (exposure_binary) {
      row$exposed <- describe(d[[column]], d$exposure == 1)
      row$unexposed <- describe(d[[column]], d$exposure == 0)
      row$smd <- round(smd(d[[column]], d$exposure), 3)
    }
    row
  })
  header <- list(variable = "N", overall = as.character(nrow(d)))
  if (exposure_binary) { header$exposed <- suppress(sum(d$exposure == 1)); header$unexposed <- suppress(sum(d$exposure == 0)); header$smd <- NA }
  result$tables$table1 <<- c(list(header), rows)
}

# ---------- regression helpers ----------
outcome_family <- function() switch(outcome_type, binary = binomial(), count = poisson(), gaussian())
effect_measure <- function() switch(outcome_type, binary = "odds_ratio", count = "rate_ratio", continuous = "mean_difference", "mean_difference")
report_term <- function(fit, term, label = term, vcov_matrix = NULL, measure = effect_measure()) {
  co <- coef(fit)
  if (!(term %in% names(co)) || is.na(co[[term]])) { warn(paste0("The term ", term, " could not be estimated.")); return(invisible(NULL)) }
  v <- if (is.null(vcov_matrix)) vcov(fit) else vcov_matrix
  se <- sqrt(v[term, term]); est <- co[[term]]
  p <- 2 * pnorm(-abs(est / se))
  if (measure %in% c("odds_ratio", "rate_ratio", "risk_ratio", "hazard_ratio")) add_estimate(term, measure, exp(est), exp(est - z * se), exp(est + z * se), p, label)
  else add_estimate(term, measure, est, est - z * se, est + z * se, p, label)
  # The coefficient and its standard error on the model scale, for a test that compares reported estimates.
  invisible(list(estimate = unname(est), se = unname(se)))
}
robust_vcov <- function(fit, cluster = NULL) {
  if (!requireNamespace("sandwich", quietly = TRUE)) { warn("sandwich is unavailable; model-based standard errors were used."); return(vcov(fit)) }
  if (is.null(cluster)) sandwich::vcovHC(fit, type = "HC0") else sandwich::vcovCL(fit, cluster = cluster)
}
events_per_parameter <- function(parameters) {
  if (outcome_type == "binary") { events <- min(sum(d$outcome == 1), sum(d$outcome == 0)) }
  else if (outcome_type == "time_to_event") { events <- sum(d$event == 1) } else return(invisible(NULL))
  epv <- events / max(1, parameters)
  result$diagnostics$events <<- events
  result$diagnostics$events_per_parameter <<- round(epv, 2)
  if (epv < 10) warn(sprintf("Only %.1f events per model parameter; estimates may be unstable (recommended at least 10).", epv))
}
risk_difference <- function(weights = NULL) {
  if (outcome_type != "binary" || !exposure_binary) return(invisible(NULL))
  w <- if (is.null(weights)) rep(1, nrow(d)) else weights
  p1 <- weighted.mean(d$outcome[d$exposure == 1], w[d$exposure == 1]); p0 <- weighted.mean(d$outcome[d$exposure == 0], w[d$exposure == 0])
  n1 <- sum(w[d$exposure == 1])^2 / sum(w[d$exposure == 1]^2); n0 <- sum(w[d$exposure == 0])^2 / sum(w[d$exposure == 0]^2)
  se <- sqrt(p1 * (1 - p1) / n1 + p0 * (1 - p0) / n0)
  add_estimate("exposure", "risk_difference", p1 - p0, p1 - p0 - z * se, p1 - p0 + z * se, 2 * pnorm(-abs((p1 - p0) / se)), paste0(label_of("exposure"), " (risk difference)"))
  result$diagnostics$risk_exposed <<- round(p1, 4); result$diagnostics$risk_unexposed <<- round(p0, 4)
}
forest_plot <- function(file, title, rows) {
  if (!length(rows)) return(invisible(NULL))
  est <- vapply(rows, function(r) r$estimate, numeric(1)); lo <- vapply(rows, function(r) r$ci_low %||% NA, numeric(1)); hi <- vapply(rows, function(r) r$ci_high %||% NA, numeric(1))
  labels <- vapply(rows, function(r) r$label, character(1))
  ratio <- rows[[1]]$measure %in% c("odds_ratio", "rate_ratio", "risk_ratio", "hazard_ratio")
  # A diverged fit (an interval of 1e-62 to 1e+53) cannot be drawn: infinite or absurd limits are left off the plot.
  limit <- if (ratio) c(1e-3, 1e3) else c(-1e6, 1e6)
  est[!is.finite(est) | est < limit[1] | est > limit[2]] <- NA; lo[!is.finite(lo) | lo < limit[1] | lo > limit[2]] <- NA; hi[!is.finite(hi) | hi < limit[1] | hi > limit[2]] <- NA
  if (all(is.na(c(est, lo, hi)))) { warn(paste0("The figure '", title, "' was not drawn: every estimate or interval is outside the plausible range.")); return(invisible(NULL)) }
  png_open(file, height = max(700, 180 + 110 * length(rows)))
  par(mar = c(4.5, 14, 3, 1.5))
  y <- rev(seq_along(rows)); range_x <- range(c(lo, hi, est, if (ratio) 1 else 0), na.rm = TRUE)
  plot(est, y, xlim = range_x, ylim = c(0.5, length(rows) + 0.5), yaxt = "n", pch = 15, xlab = rows[[1]]$measure, ylab = "", main = title, log = if (ratio && all(c(lo, hi, est) > 0, na.rm = TRUE)) "x" else "")
  segments(lo, y, hi, y); abline(v = if (ratio) 1 else 0, lty = 2, col = "grey40")
  axis(2, at = y, labels = labels, las = 1, cex.axis = 0.8)
  dev.off(); add_figure(file, title, "forest")
}

# ---------- propensity scores ----------
propensity <- function(data = d) {
  if (!exposure_binary) stop("Propensity methods need a binary exposure.")
  if (!length(covariates)) stop("Propensity methods need at least one adjustment covariate.")
  fit <- glm(as.formula(paste("exposure ~", rhs(covariates))), data = data, family = binomial())
  ps <- pmin(pmax(fitted(fit), 1e-6), 1 - 1e-6)
  result$diagnostics$ps_range_exposed <<- round(range(ps[data$exposure == 1]), 4)
  result$diagnostics$ps_range_unexposed <<- round(range(ps[data$exposure == 0]), 4)
  ps
}
balance <- function(weights, file, title) {
  rows <- lapply(covariates, function(column) list(variable = label_of(column), smd_before = round(smd(d[[column]], d$exposure), 3), smd_after = round(smd(d[[column]], d$exposure, weights), 3)))
  result$tables$balance <<- rows
  after <- vapply(rows, function(r) r$smd_after, numeric(1))
  result$diagnostics$max_smd_after <<- round(max(after), 3)
  if (max(after) > 0.1) warn(sprintf("Residual imbalance after adjustment: maximum SMD %.2f exceeds 0.1.", max(after)))
  png_open(file, height = max(700, 200 + 90 * length(rows)))
  par(mar = c(4.5, 12, 3, 1.5))
  before <- vapply(rows, function(r) r$smd_before, numeric(1)); y <- seq_along(rows)
  plot(before, y, xlim = c(0, max(c(before, after, 0.15))), pch = 1, yaxt = "n", xlab = "Absolute standardized mean difference", ylab = "", main = title)
  points(after, y, pch = 19); abline(v = 0.1, lty = 2, col = "grey40")
  axis(2, at = y, labels = vapply(rows, function(r) r$variable, character(1)), las = 1, cex.axis = 0.8)
  legend("topright", c("Before", "After"), pch = c(1, 19), bty = "n")
  dev.off(); add_figure(file, title, "balance")
}
# Truncates weights at percentiles computed within each treatment group; pooled percentiles would clip every
# exposed patient's weight when the exposure is rare.
truncate_within_groups <- function(w, level) {
  for (group in c(0, 1)) {
    rows <- d$exposure == group
    bounds <- quantile(w[rows], c(level, 1 - level))
    w[rows] <- pmin(pmax(w[rows], bounds[1]), bounds[2])
  }
  w
}
iptw <- function() {
  ps <- propensity()
  p_exposed <- mean(d$exposure)
  w <- truncate_within_groups(ifelse(d$exposure == 1, p_exposed / ps, (1 - p_exposed) / (1 - ps)), 0.01)
  result$diagnostics$effective_sample_size <<- round(sum(w)^2 / sum(w^2), 1)
  png_open("ps_overlap.png")
  breaks <- seq(0, 1, by = 0.05)
  h1 <- hist(ps[d$exposure == 1], breaks = breaks, plot = FALSE); h0 <- hist(ps[d$exposure == 0], breaks = breaks, plot = FALSE)
  plot(h0, col = rgb(0.2, 0.4, 0.8, 0.4), main = "Propensity score overlap", xlab = "Propensity score", freq = FALSE, ylim = c(0, max(h0$density, h1$density)))
  plot(h1, col = rgb(0.9, 0.4, 0.2, 0.4), add = TRUE, freq = FALSE)
  legend("topright", c("Unexposed", "Exposed"), fill = c(rgb(0.2, 0.4, 0.8, 0.4), rgb(0.9, 0.4, 0.2, 0.4)), bty = "n")
  dev.off(); add_figure("ps_overlap.png", "Propensity score overlap", "overlap")
  w
}
psm_match <- function() {
  ps <- propensity(); logit <- qlogis(ps); caliper <- 0.2 * sd(logit)
  treated <- sample(which(d$exposure == 1)); controls <- which(d$exposure == 0); used <- rep(FALSE, nrow(d)); pairs <- integer(); pair_id <- rep(NA_integer_, nrow(d))
  for (i in treated) {
    available <- controls[!used[controls]]
    if (!length(available)) break
    distance <- abs(logit[available] - logit[i]); best <- which.min(distance)
    if (distance[best] <= caliper) { j <- available[best]; used[j] <- TRUE; used[i] <- TRUE; pairs <- c(pairs, i, j); pair_id[c(i, j)] <- length(pairs) / 2 }
  }
  matched_pairs <- length(pairs) / 2
  result$diagnostics$matched_pairs <<- matched_pairs
  result$diagnostics$caliper_logit <<- round(caliper, 4)
  result$diagnostics$treated_unmatched <<- length(treated) - matched_pairs
  if (matched_pairs < 20) stop("Fewer than 20 matched pairs within the caliper.")
  list(rows = pairs, pair_id = pair_id)
}

# ---------- methods ----------
# A continuous exposure is reported per one unit, which is unreadable for a lipid in mg/dL (an odds ratio a hair away from 1); the same effect
# per one standard deviation of the exposure is added beside it.
per_standard_deviation <- function(fit, vcov_matrix = NULL) {
  if (exposure_binary || !is.numeric(d$exposure)) return(invisible(NULL))
  spread <- sd(d$exposure, na.rm = TRUE); co <- coef(fit)
  if (!is.finite(spread) || spread <= 0 || is.na(co[["exposure"]])) return(invisible(NULL))
  v <- if (is.null(vcov_matrix)) vcov(fit) else vcov_matrix; se <- sqrt(v["exposure", "exposure"]); est <- co[["exposure"]] * spread; half <- z * se * spread
  label <- sprintf("%s (per 1 SD = %s)", label_of("exposure"), format(signif(spread, 3), trim = TRUE))
  if (effect_measure() %in% c("odds_ratio", "rate_ratio", "risk_ratio", "hazard_ratio")) add_estimate("exposure_per_sd", effect_measure(), exp(est), exp(est - half), exp(est + half), 2 * pnorm(-abs(est / (se * spread))), label)
  else add_estimate("exposure_per_sd", effect_measure(), est, est - half, est + half, 2 * pnorm(-abs(est / (se * spread))), label)
}
run_regression <- function(robust = FALSE, poisson_rr = FALSE, nonlinear = FALSE) {
  terms <- c("exposure", covariates)
  events_per_parameter(length(terms))
  if (nonlinear && is.numeric(d$exposure) && !exposure_binary) return(run_rcs())
  if (poisson_rr && outcome_type == "binary") {
    fit <- glm(as.formula(paste("outcome ~", rhs(terms))), data = d, family = poisson())
    report_term(fit, "exposure", paste0(label_of("exposure"), " (adjusted)"), robust_vcov(fit), "risk_ratio")
    return(invisible(fit))
  }
  fit <- glm(as.formula(paste("outcome ~", rhs(terms))), data = d, family = outcome_family())
  report_term(fit, "exposure", paste0(label_of("exposure"), " (adjusted)"), if (robust) robust_vcov(fit) else NULL)
  per_standard_deviation(fit, if (robust) robust_vcov(fit) else NULL)
  crude <- glm(outcome ~ exposure, data = d, family = outcome_family())
  report_term(crude, "exposure", paste0(label_of("exposure"), " (crude)"))
  forest_plot("estimates.png", paste0("Effect of ", label_of("exposure")), Filter(function(row) row$measure == effect_measure(), result$estimates))
  risk_difference()
  invisible(fit)
}
run_rcs <- function() {
  if (!is.numeric(d$exposure) || exposure_binary) stop("Restricted cubic splines need a continuous exposure.")
  base <- glm(as.formula(paste("outcome ~", rhs(covariates))), data = d, family = outcome_family())
  linear <- glm(as.formula(paste("outcome ~", rhs(c("exposure", covariates)))), data = d, family = outcome_family())
  # A dose that takes only a few distinct values (a count of records: 0, 1, 2) has no room for spline knots; report the linear term and say why.
  spline <- tryCatch(glm(as.formula(paste("outcome ~", rhs(c("ns(exposure, df = 3)", covariates)))), data = d, family = outcome_family()), error = function(e) NULL)
  if (is.null(spline)) {
    report_term(linear, "exposure", paste0(label_of("exposure"), " (per unit, linear)"))
    warn("The exposure takes too few distinct values for a spline; only the linear association is reported.")
    return(invisible(linear))
  }
  test <- if (outcome_type == "continuous") "F" else "LRT"
  p_overall <- anova(base, spline, test = test)[2, ncol(anova(base, spline, test = test))]
  p_nonlinear <- anova(linear, spline, test = test)[2, ncol(anova(linear, spline, test = test))]
  result$diagnostics$p_overall <<- p_overall; result$diagnostics$p_nonlinear <<- p_nonlinear
  report_term(linear, "exposure", paste0(label_of("exposure"), " (per unit, linear)"))
  grid <- seq(quantile(d$exposure, 0.05), quantile(d$exposure, 0.95), length.out = 100); reference <- median(d$exposure)
  newdata <- d[rep(1, length(grid) + 1), , drop = FALSE]
  for (column in covariates) newdata[[column]] <- if (is.factor(d[[column]])) factor(names(which.max(table(d[[column]]))), levels = levels(d[[column]])) else median(d[[column]])
  newdata$exposure <- c(grid, reference)
  prediction <- predict(spline, newdata = newdata, type = "link", se.fit = TRUE)
  contrast <- prediction$fit[seq_along(grid)] - prediction$fit[length(grid) + 1]
  ratio <- outcome_type %in% c("binary", "count")
  y <- if (ratio) exp(contrast) else contrast
  png_open("dose_response.png")
  plot(grid, y, type = "l", lwd = 2, xlab = label_of("exposure"), ylab = if (ratio) "Relative to median (ratio)" else "Difference from median", main = sprintf("Dose-response (P overall %.3g, P nonlinear %.3g)", p_overall, p_nonlinear), log = if (ratio) "y" else "")
  abline(h = if (ratio) 1 else 0, lty = 2, col = "grey40"); rug(quantile(d$exposure, seq(0.1, 0.9, 0.1)))
  dev.off(); add_figure("dose_response.png", "Restricted cubic spline dose-response curve", "dose_response")
  invisible(spline)
}
run_quartiles <- function() {
  if (!is.numeric(d$exposure) || exposure_binary) stop("Quartile analysis needs a continuous exposure.")
  breaks <- unique(quantile(d$exposure, seq(0, 1, 0.25)))
  if (length(breaks) < 3) stop("The exposure has too few distinct values for quartiles.")
  d$exposure_q <<- cut(d$exposure, breaks, include.lowest = TRUE, labels = paste0("Q", seq_len(length(breaks) - 1)))
  fit <- glm(as.formula(paste("outcome ~", rhs(c("exposure_q", covariates)))), data = d, family = outcome_family())
  for (level in levels(d$exposure_q)[-1]) report_term(fit, paste0("exposure_q", level), paste0(label_of("exposure"), " ", level, " vs Q1"))
  medians <- tapply(d$exposure, d$exposure_q, median); d$exposure_trend <<- medians[as.character(d$exposure_q)]
  trend <- glm(as.formula(paste("outcome ~", rhs(c("exposure_trend", covariates)))), data = d, family = outcome_family())
  result$diagnostics$p_trend <<- summary(trend)$coefficients["exposure_trend", 4]
  forest_plot("quartiles.png", "Exposure quartiles (reference Q1)", result$estimates)
}
run_iptw <- function() {
  w <- iptw(); balance(w, "balance.png", "Covariate balance before and after weighting")
  fit <- suppressWarnings(glm(outcome ~ exposure, data = d, family = outcome_family(), weights = w))
  report_term(fit, "exposure", paste0(label_of("exposure"), " (IPTW)"), robust_vcov(fit))
  truncated <- iptw_sensitivity(0.05)
  forest_plot("estimates.png", paste0("Effect of ", label_of("exposure")), Filter(function(row) row$measure == effect_measure(), result$estimates))
  risk_difference(w)
  invisible(fit)
}
iptw_sensitivity <- function(level) {
  ps <- propensity(); p_exposed <- mean(d$exposure)
  w <- truncate_within_groups(ifelse(d$exposure == 1, p_exposed / ps, (1 - p_exposed) / (1 - ps)), level)
  fit <- suppressWarnings(glm(outcome ~ exposure, data = d, family = outcome_family(), weights = w))
  report_term(fit, "exposure", sprintf("%s (IPTW, %d/%d%% truncation, sensitivity)", label_of("exposure"), round(100 * level), round(100 * (1 - level))), robust_vcov(fit))
}
run_psm <- function() {
  matched <- psm_match(); rows <- matched$rows
  full <- d; d <<- d[rows, , drop = FALSE]; pair <- matched$pair_id[rows]
  balance(rep(1, nrow(d)), "balance.png", "Covariate balance in the matched cohort")
  for (index in seq_along(result$tables$balance)) result$tables$balance[[index]]$smd_before <<- round(smd(full[[covariates[index]]], full$exposure), 3)
  fit <- glm(outcome ~ exposure, data = d, family = outcome_family())
  report_term(fit, "exposure", paste0(label_of("exposure"), " (1:1 matched)"), robust_vcov(fit, cluster = pair))
  risk_difference()
  result$n_analysed <<- nrow(d)
}
run_cox <- function(weights = NULL, label = "adjusted") {
  if (!all(c("time", "event") %in% names(d))) stop("Time-to-event methods need time and event columns.")
  events_per_parameter(1 + length(covariates))
  terms <- if (is.null(weights)) c("exposure", covariates) else "exposure"
  fit <- if (is.null(weights)) coxph(as.formula(paste("Surv(time, event) ~", rhs(terms))), data = d) else coxph(Surv(time, event) ~ exposure, data = d, weights = weights, robust = TRUE)
  report_term(fit, "exposure", paste0(label_of("exposure"), " (", label, ")"), NULL, "hazard_ratio")
  ph <- tryCatch(cox.zph(fit), error = function(e) NULL)
  if (!is.null(ph)) { result$diagnostics$ph_test_global_p <<- ph$table["GLOBAL", "p"]; if (ph$table["GLOBAL", "p"] < 0.05) warn("The proportional hazards assumption may be violated (global Schoenfeld test P < 0.05).") }
  km_plot(weights)
  invisible(fit)
}
km_plot <- function(weights = NULL) {
  if (!exposure_binary) return(invisible(NULL))
  fit <- survfit(Surv(time, event) ~ exposure, data = d, weights = weights)
  png_open("kaplan_meier.png")
  plot(fit, col = c("steelblue", "firebrick"), lwd = 2, xlab = paste0("Time (", cfg$time_unit %||% "days", ")"), ylab = "Survival probability", main = "Kaplan-Meier survival", mark.time = FALSE)
  legend("bottomleft", c("Unexposed", "Exposed"), col = c("steelblue", "firebrick"), lwd = 2, bty = "n")
  dev.off(); add_figure("kaplan_meier.png", "Kaplan-Meier survival by exposure", "kaplan_meier")
  times <- pretty(c(0, max(d$time)), n = 5); s <- summary(fit, times = times, extend = TRUE)
  result$tables$number_at_risk <<- lapply(seq_along(s$time), function(i) list(time = s$time[i], group = as.character(s$strata[i]), at_risk = suppress(round(s$n.risk[i])), survival = round(s$surv[i], 4)))
}
run_km_logrank <- function() {
  if (!exposure_binary) stop("Log-rank comparison needs a binary exposure.")
  test <- survdiff(Surv(time, event) ~ exposure, data = d)
  p <- 1 - pchisq(test$chisq, length(test$n) - 1)
  result$diagnostics$logrank_p <<- p
  fit <- survfit(Surv(time, event) ~ exposure, data = d)
  medians <- summary(fit)$table[, "median"]
  add_estimate("exposure", "logrank_chisq", test$chisq, NA, NA, p, "Log-rank test")
  result$tables$median_survival <<- lapply(seq_along(medians), function(i) list(group = names(medians)[i], median = unname(medians[i])))
  km_plot()
}
# The outcome in each group: event rate with an exact binomial CI, or the mean with a t CI.
group_summaries <- function() {
  for (level in sort(unique(as.character(d$exposure)))) {
    values <- d$outcome[as.character(d$exposure) == level]
    if (outcome_type == "binary") {
      events <- sum(as.logical(values)); n <- length(values)
      ci <- stats::binom.test(events, n)$conf.int
      add_estimate(paste0("group:", level), "proportion", events / n, ci[1], ci[2], NA, paste0(level, " (n=", n, ")"))
    } else if (length(values) >= 2) {
      ci <- stats::t.test(values)$conf.int
      add_estimate(paste0("group:", level), "mean", mean(values), ci[1], ci[2], NA, paste0(level, " (n=", length(values), ")"))
    }
  }
}
run_group_test <- function() {
  if (outcome_type == "binary") {
    tab <- table(d$exposure, d$outcome)
    test <- if (any(suppressWarnings(chisq.test(tab)$expected) < 5)) fisher.test(tab) else chisq.test(tab)
    add_estimate("exposure", "test_statistic", unname(test$statistic %||% NA), NA, NA, test$p.value, test$method)
    if (length(unique(d$exposure)) == 2) risk_difference()
    group_summaries()
  } else {
    groups <- split(d$outcome, d$exposure)
    if (length(groups) != 2) {
      test <- kruskal.test(outcome ~ factor(exposure), data = d)
      add_estimate("exposure", "test_statistic", unname(test$statistic), NA, NA, test$p.value, test$method)
      group_summaries()
    } else {
      normal <- all(vapply(groups, function(g) length(g) >= 30 || (length(g) >= 3 && shapiro.test(g)$p.value > 0.05), logical(1)))
      test <- if (normal) t.test(groups[[2]], groups[[1]]) else wilcox.test(groups[[2]], groups[[1]], conf.int = TRUE)
      add_estimate("exposure", if (normal) "mean_difference" else "location_shift", unname(test$estimate[1] - if (normal) test$estimate[2] else 0), test$conf.int[1], test$conf.int[2], test$p.value, test$method)
    }
  }
}
run_interaction <- function(weighted = FALSE) {
  if (is.null(modifier)) stop("Effect modification needs a modifier column.")
  if (!weighted) {
    others <- setdiff(covariates, modifier)
    full <- glm(as.formula(paste("outcome ~", rhs(c(paste0("exposure * ", modifier), others)))), data = d, family = outcome_family())
    reduced <- glm(as.formula(paste("outcome ~", rhs(c("exposure", modifier, others)))), data = d, family = outcome_family())
    test <- anova(reduced, full, test = if (outcome_type == "continuous") "F" else "LRT")
    result$diagnostics$p_interaction <<- test[2, ncol(test)]
    run_stratified()
    return(invisible(NULL))
  }
  # With propensity weights the test compares the effects it reports: the IPTW estimates inside each level, with robust
  # standard errors, are tested for equality (Wald heterogeneity test). A likelihood-ratio or F test of a model weighted over
  # the whole cohort treats the weights as precision weights and tests a differently weighted effect; it gave a very small P
  # value for two level estimates whose difference was smaller than its standard error.
  iptw()  # the whole-cohort propensity overlap figure; the weights used are fitted within each level
  effects <- run_stratified(weighted = TRUE)
  if (length(effects) < 2) { warn("Fewer than two levels of the modifier could be estimated, so the difference in effect was not tested."); return(invisible(NULL)) }
  b <- vapply(effects, function(effect) effect$estimate, numeric(1)); w <- 1 / vapply(effects, function(effect) effect$se, numeric(1))^2
  heterogeneity <- sum(w * (b - sum(w * b) / sum(w))^2)
  result$diagnostics$p_interaction <<- pchisq(heterogeneity, df = length(b) - 1, lower.tail = FALSE)
}
# With weighted = TRUE the effect inside each level of the modifier is an IPTW estimate: propensity weights are fitted within that level,
# so confounding is balanced there and not only in the whole cohort; standard errors are robust.
run_stratified <- function(weighted = FALSE) {
  if (is.null(modifier)) stop("Stratified analysis needs a modifier column.")
  levels_m <- if (is.factor(d[[modifier]])) levels(d[[modifier]]) else if (all(d[[modifier]] %in% c(0, 1))) c(0, 1) else NULL
  strata <- if (is.null(levels_m)) { cut_at <- median(d[[modifier]]); list(below = d[[modifier]] <= cut_at, above = d[[modifier]] > cut_at) } else setNames(lapply(levels_m, function(level) d[[modifier]] == level), as.character(levels_m))
  others <- setdiff(covariates, modifier)
  effects <- list(); effective <- 0
  for (name in names(strata)) {
    rows <- strata[[name]]
    if (sum(rows) < 20) { warn(sprintf("Stratum %s = %s has fewer than 20 rows and was not estimated.", label_of(modifier), name)); next }
    sub <- d[rows, , drop = FALSE]
    keep <- others[vapply(others, function(column) length(unique(sub[[column]])) > 1, logical(1))]
    weights_sub <- NULL
    if (weighted && exposure_binary && length(keep)) {
      ps_fit <- tryCatch(glm(as.formula(paste("exposure ~", rhs(keep))), data = sub, family = binomial()), error = function(e) NULL)
      if (is.null(ps_fit)) warn(sprintf("The propensity model could not be fitted in %s = %s; the estimate there is not weighted.", label_of(modifier), name))
      else {
        ps_sub <- pmin(pmax(fitted(ps_fit), 1e-6), 1 - 1e-6); p_sub <- mean(sub$exposure)
        weights_sub <- ifelse(sub$exposure == 1, p_sub / ps_sub, (1 - p_sub) / (1 - ps_sub))
        for (group in c(0, 1)) { in_group <- sub$exposure == group; bounds <- quantile(weights_sub[in_group], c(0.01, 0.99)); weights_sub[in_group] <- pmin(pmax(weights_sub[in_group], bounds[1]), bounds[2]) }
      }
    }
    effective <- effective + if (is.null(weights_sub)) nrow(sub) else sum(weights_sub)^2 / sum(weights_sub^2)
    if (is.null(weights_sub)) {
      fit <- glm(as.formula(paste("outcome ~", rhs(c("exposure", keep)))), data = sub, family = outcome_family())
      effects[[name]] <- report_term(fit, "exposure", sprintf("%s in %s = %s", label_of("exposure"), label_of(modifier), name))
    } else {
      fit <- suppressWarnings(glm(outcome ~ exposure, data = sub, family = outcome_family(), weights = weights_sub))
      effects[[name]] <- report_term(fit, "exposure", sprintf("%s in %s = %s (IPTW)", label_of("exposure"), label_of(modifier), name), robust_vcov(fit))
    }
  }
  # The weight checks describe the weights the estimates use: the effective sample summed over the levels.
  if (weighted) result$diagnostics$effective_sample_size <<- round(effective, 1)
  forest_plot("effect_modification.png", sprintf("Effect of %s by %s", label_of("exposure"), label_of(modifier)), result$estimates)
  invisible(effects)
}
run_mediation <- function(method) {
  if (is.null(mediator)) stop("Mediation needs a mediator column.")
  m_family <- if (all(d[[mediator]] %in% c(0, 1))) binomial() else gaussian()
  model_m <- glm(as.formula(paste(mediator, "~", rhs(c("exposure", covariates)))), data = d, family = m_family)
  model_y <- glm(as.formula(paste("outcome ~", rhs(c("exposure", mediator, covariates)))), data = d, family = outcome_family())
  if (method == "mediate") {
    fit <- mediation::mediate(model_m, model_y, treat = "exposure", mediator = mediator, sims = cfg$simulations %||% 500)
    add_estimate("acme", "indirect_effect", fit$d.avg, fit$d.avg.ci[1], fit$d.avg.ci[2], fit$d.avg.p, "Average causal mediation effect")
    add_estimate("ade", "direct_effect", fit$z.avg, fit$z.avg.ci[1], fit$z.avg.ci[2], fit$z.avg.p, "Average direct effect")
    add_estimate("total", "total_effect", fit$tau.coef, fit$tau.ci[1], fit$tau.ci[2], fit$tau.p, "Total effect")
    add_estimate("proportion", "proportion_mediated", fit$n.avg, fit$n.avg.ci[1], fit$n.avg.ci[2], fit$n.avg.p, "Proportion mediated")
    if (fit$tau.ci[1] <= 0 && fit$tau.ci[2] >= 0) warn("The total effect's confidence interval includes zero, so the proportion mediated is not interpretable.")
    else if (sign(fit$d.avg) != sign(fit$z.avg)) warn("Direct and indirect effects have opposite signs (inconsistent mediation); the proportion mediated is not interpretable.")
    if (outcome_type == "binary") warn("Mediation effects for a binary outcome are on the probability (risk difference) scale.")
  } else {
    a <- coef(model_m)[["exposure"]]; b <- coef(model_y)[[mediator]]
    sa <- sqrt(vcov(model_m)["exposure", "exposure"]); sb <- sqrt(vcov(model_y)[mediator, mediator])
    if (method == "product") {
      ab <- a * b; se <- sqrt(a^2 * sb^2 + b^2 * sa^2)
      add_estimate("indirect", "indirect_effect_product", ab, ab - z * se, ab + z * se, 2 * pnorm(-abs(ab / se)), "Indirect effect (product of coefficients, Sobel)")
    } else {
      total <- glm(as.formula(paste("outcome ~", rhs(c("exposure", covariates)))), data = d, family = outcome_family())
      difference <- function(data) coef(glm(as.formula(paste("outcome ~", rhs(c("exposure", covariates)))), data = data, family = outcome_family()))[["exposure"]] - coef(glm(as.formula(paste("outcome ~", rhs(c("exposure", mediator, covariates)))), data = data, family = outcome_family()))[["exposure"]]
      boots <- replicate(cfg$bootstrap %||% 200, difference(d[sample(nrow(d), replace = TRUE), , drop = FALSE]))
      estimate <- difference(d)
      add_estimate("indirect", "indirect_effect_difference", estimate, quantile(boots, alpha / 2), quantile(boots, 1 - alpha / 2), NA, "Indirect effect (difference method, bootstrap CI)")
    }
    if (outcome_type == "binary") warn("With a binary outcome, product and difference estimates are on the log-odds scale and are only approximately comparable.")
  }
}
split_rows <- function() {
  if (outcome_type == "binary") {
    test <- unlist(lapply(split(seq_len(nrow(d)), d$outcome), function(rows) sample(rows, round(0.3 * length(rows)))))
  } else test <- sample(nrow(d), round(0.3 * nrow(d)))
  seq_len(nrow(d)) %in% test
}
evaluate_prediction <- function(probability, observed, name) {
  roc <- pROC::roc(observed, probability, quiet = TRUE); ci <- pROC::ci.auc(roc)
  add_estimate("auc", "auc", as.numeric(pROC::auc(roc)), ci[1], ci[3], NA, paste0(name, " AUC (test set)"))
  result$diagnostics$brier <<- round(mean((probability - observed)^2), 4)
  logit_p <- qlogis(pmin(pmax(probability, 1e-6), 1 - 1e-6)); calibration <- glm(observed ~ logit_p, family = binomial())
  result$diagnostics$calibration_intercept <<- round(coef(calibration)[[1]], 3); result$diagnostics$calibration_slope <<- round(coef(calibration)[[2]], 3)
  png_open("roc.png"); plot(roc, main = sprintf("ROC (AUC %.3f)", pROC::auc(roc)), legacy.axes = TRUE); dev.off(); add_figure("roc.png", "Receiver operating characteristic curve (test set)", "roc")
  bins <- cut(probability, unique(quantile(probability, seq(0, 1, 0.1))), include.lowest = TRUE)
  png_open("calibration.png"); plot(tapply(probability, bins, mean), tapply(observed, bins, mean), xlim = c(0, 1), ylim = c(0, 1), pch = 19, xlab = "Predicted risk", ylab = "Observed risk", main = "Calibration (deciles, test set)"); abline(0, 1, lty = 2); dev.off()
  add_figure("calibration.png", "Calibration plot (test set)", "calibration")
}
run_prediction <- function(method) {
  if (outcome_type != "binary") stop("Prediction methods currently support binary outcomes.")
  if (!length(predictors)) stop("Prediction needs at least one predictor column.")
  test <- split_rows(); train <- d[!test, , drop = FALSE]; hold <- d[test, , drop = FALSE]
  result$diagnostics$train_rows <<- nrow(train); result$diagnostics$test_rows <<- nrow(hold)
  events_per_parameter(length(predictors))
  if (method == "lasso") {
    x_train <- model.matrix(as.formula(paste("~", rhs(predictors))), train)[, -1, drop = FALSE]; x_test <- model.matrix(as.formula(paste("~", rhs(predictors))), hold)[, -1, drop = FALSE]
    if (ncol(x_train) < 2) stop("LASSO needs at least two predictor columns.")
    fit <- glmnet::cv.glmnet(x_train, train$outcome, family = "binomial", alpha = 1)
    coefs <- as.matrix(coef(fit, s = "lambda.1se")); selected <- rownames(coefs)[coefs[, 1] != 0 & rownames(coefs) != "(Intercept)"]
    result$tables$selected_predictors <<- lapply(selected, function(name) list(predictor = name, coefficient = round(coefs[name, 1], 4)))
    probability <- as.numeric(predict(fit, x_test, s = "lambda.1se", type = "response"))
  } else {
    terms <- if (method == "rcs") vapply(predictors, function(column) if (is.numeric(d[[column]]) && length(unique(d[[column]])) > 5) sprintf("ns(%s, df = 3)", column) else column, character(1)) else predictors
    fit <- glm(as.formula(paste("outcome ~", rhs(terms))), data = train, family = binomial())
    if (method != "rcs") for (column in predictors) if (is.numeric(d[[column]])) report_term(fit, column, paste0(label_of(column), " (per unit)"))
    probability <- predict(fit, newdata = hold, type = "response")
  }
  evaluate_prediction(probability, hold$outcome, switch(method, lasso = "LASSO logistic", rcs = "Spline logistic", "Logistic"))
  prediction_references(probability, train, hold, terms_for_cv = if (method == "lasso") NULL else if (method == "rcs") terms else predictors)
}
# Complete-case results describe only patients with every predictor. This refits the model on all patients that have the
# outcome, with missing predictors filled by chained equations (mice, one imputed set, predictive mean matching), and
# scores a held-out third of them, so the gap between the two AUCs shows how much the missing data matter.
missing_data_comparison <- function(terms_for_cv, complete_case_probability, hold) {
  if (is.null(terms_for_cv) || !exists("d_all", inherits = TRUE)) return(invisible(NULL))
  tryCatch({
    columns <- unique(c("outcome", predictors, setdiff(covariates, predictors)))
    wide <- d_all[!is.na(d_all$outcome), columns, drop = FALSE]
    gaps <- sum(!complete.cases(wide))
    if (gaps < 0.05 * nrow(wide) || nrow(wide) < 200) return(invisible(NULL))
    sampled <- nrow(wide) > 20000
    if (sampled) wide <- wide[sample(nrow(wide), 20000), , drop = FALSE]
    keep <- vapply(wide, function(column) mean(is.na(column)) < 0.9, logical(1)); wide <- wide[, keep, drop = FALSE]
    if (!("outcome" %in% names(wide))) return(invisible(NULL))
    # The outcome is left out of the imputation model: imputing with it would put the outcome into the held-out
    # predictors and inflate the AUC.
    outcome_values <- wide$outcome
    imputed <- mice::mice(wide[, setdiff(names(wide), "outcome"), drop = FALSE], m = 1, maxit = 3, method = "pmm", printFlag = FALSE, seed = 1)
    full <- cbind(mice::complete(imputed, 1), outcome = outcome_values)
    test <- split_rows_for(full$outcome)
    fit <- glm(as.formula(paste("outcome ~", rhs(intersect(terms_for_cv, names(full))))), data = full[!test, , drop = FALSE], family = binomial())
    probability <- predict(fit, newdata = full[test, , drop = FALSE], type = "response")
    roc <- pROC::roc(full$outcome[test], probability, quiet = TRUE); ci <- pROC::ci.auc(roc)
    add_estimate("auc_imputed", "auc", as.numeric(pROC::auc(roc)), ci[1], ci[3], NA, sprintf("AUC with missing predictors imputed (%s patients with the outcome%s, held-out third)", format(nrow(wide), big.mark = ","), if (sampled) ", a random sample" else ""))
    # The same patients scored by the background characteristics alone: the imputed set includes patients who were never
    # measured, so a high AUC there can come from who was measured rather than from the predictors.
    background <- setdiff(covariates, predictors)
    if (length(background)) {
      base_fit <- glm(as.formula(paste("outcome ~", rhs(background))), data = full[!test, , drop = FALSE], family = binomial())
      base_roc <- pROC::roc(full$outcome[test], predict(base_fit, newdata = full[test, , drop = FALSE], type = "response"), quiet = TRUE); base_ci <- pROC::ci.auc(base_roc)
      add_estimate("auc_imputed_baseline", "auc", as.numeric(pROC::auc(base_roc)), base_ci[1], base_ci[3], NA, "Baseline AUC on the same imputed patients (background characteristics only)")
      result$diagnostics$imputed_auc_gain_over_baseline <<- round(as.numeric(pROC::auc(roc)) - as.numeric(pROC::auc(base_roc)), 4)
    }
    result$diagnostics$imputed_rows <<- nrow(wide); result$diagnostics$imputed_incomplete_rows <<- gaps
  }, error = function(e) warn(paste0("The missing-data comparison could not be computed: ", conditionMessage(e))))
}
split_rows_for <- function(outcome) {
  test <- unlist(lapply(split(seq_along(outcome), outcome), function(rows) sample(rows, round(0.3 * length(rows)))))
  seq_along(outcome) %in% test
}
# What the predictors add and how stable the performance is: the same test rows scored by a model of the background
# characteristics alone (the study's adjustment covariates), a paired DeLong comparison, and a 5-fold cross-validated AUC.
prediction_references <- function(probability, train, hold, terms_for_cv) {
  tryCatch({
    background <- setdiff(covariates, predictors)
    if (length(background)) {
      base_fit <- glm(as.formula(paste("outcome ~", rhs(background))), data = train, family = binomial())
      base_probability <- predict(base_fit, newdata = hold, type = "response")
      base_roc <- pROC::roc(hold$outcome, base_probability, quiet = TRUE); model_roc <- pROC::roc(hold$outcome, probability, quiet = TRUE)
      ci <- pROC::ci.auc(base_roc)
      add_estimate("auc_baseline", "auc", as.numeric(pROC::auc(base_roc)), ci[1], ci[3], NA, "Baseline AUC (background characteristics only: age, sex, comorbidity)")
      comparison <- pROC::roc.test(model_roc, base_roc, method = "delong", paired = TRUE)
      result$diagnostics$auc_gain_over_baseline <<- round(as.numeric(pROC::auc(model_roc)) - as.numeric(pROC::auc(base_roc)), 4)
      result$diagnostics$auc_gain_p <<- signif(comparison$p.value, 3)
    }
  }, error = function(e) warn(paste0("The baseline comparison could not be computed: ", conditionMessage(e))))
  missing_data_comparison(terms_for_cv, probability, hold)
  if (is.null(terms_for_cv)) return(invisible(NULL))
  tryCatch({
    folds <- sample(rep(1:5, length.out = nrow(d))); pooled <- numeric(nrow(d))
    for (k in 1:5) {
      fit_k <- glm(as.formula(paste("outcome ~", rhs(terms_for_cv))), data = d[folds != k, , drop = FALSE], family = binomial())
      pooled[folds == k] <- predict(fit_k, newdata = d[folds == k, , drop = FALSE], type = "response")
    }
    cv_roc <- pROC::roc(d$outcome, pooled, quiet = TRUE); ci <- pROC::ci.auc(cv_roc)
    add_estimate("auc_cv", "auc", as.numeric(pROC::auc(cv_roc)), ci[1], ci[3], NA, "Cross-validated AUC (5-fold, all rows)")
  }, error = function(e) warn(paste0("The cross-validated AUC could not be computed: ", conditionMessage(e))))
}
# summary: each characteristic overall and in each group; rates: in each group only; stratified: both, with a test between groups.
# The groups' shares come first (how many patients are in each, for example how many received the drug).
run_descriptive <- function(method) {
  everyone <- rep(TRUE, nrow(d))
  if (length(group_levels)) {
    known <- !is.na(group_of)
    for (level in group_levels) { k <- sum(in_group(level)); ci <- stats::binom.test(k, sum(known))$conf.int
      add_estimate(paste0("group:", level), "proportion", k / sum(known), ci[1], ci[2], NA, paste0(label_of("exposure"), ": ", level, " (overall)")) }
  }
  for (column in characteristics) {
    if (method != "rates" || !length(group_levels)) describe_estimate(column, everyone)
    for (level in group_levels) describe_estimate(column, in_group(level), level)
    if (method == "stratified" && length(group_levels) >= 2) describe_test(column)
  }
}

# E-value (VanderWeele and Ding 2017): how strong an unmeasured confounder would have to be, on the risk-ratio scale, to
# explain the estimate away. Ratios are used as they are (an odds ratio of a common outcome is first taken to its square
# root); a mean difference is converted through the outcome's standard deviation.
e_value_of <- function(rr) { rr <- max(rr, 1 / rr); rr + sqrt(rr * (rr - 1)) }
add_sensitivity <- function() {
  ratio_measures <- c("odds_ratio", "rate_ratio", "risk_ratio", "hazard_ratio")
  rows <- list()
  prevalence <- if (outcome_type == "binary") mean(d$outcome, na.rm = TRUE) else NA
  spread <- if (outcome_type != "binary") sd(d$outcome, na.rm = TRUE) else NA
  for (e in result$estimates) {
    if (grepl("sensitivity", e$label, fixed = TRUE) || is.null(e$estimate) || is.na(e$estimate)) next
    if (!(e$measure %in% ratio_measures || e$measure == "mean_difference")) next
    to_rr <- function(value) {
      if (e$measure == "mean_difference") return(exp(0.91 * value / spread))
      if (e$measure == "odds_ratio" && !is.na(prevalence) && prevalence > 0.1) return(sqrt(value))
      value
    }
    if (e$measure == "mean_difference" && (is.na(spread) || spread <= 0)) next
    if (e$measure != "mean_difference" && e$estimate <= 0) next
    point <- to_rr(e$estimate)
    low <- if (is.null(e$ci_low) || is.na(e$ci_low)) NA else to_rr(e$ci_low)
    high <- if (is.null(e$ci_high) || is.na(e$ci_high)) NA else to_rr(e$ci_high)
    null_value <- 1
    crosses <- !is.na(low) && !is.na(high) && low <= null_value && high >= null_value
    closest <- if (is.na(low) || is.na(high)) NA else if (point >= 1) low else high
    rows[[length(rows) + 1]] <- list(estimate = e$label, e_value = round(e_value_of(point), 2), e_value_ci = if (crosses) 1 else if (is.na(closest)) NA else round(e_value_of(closest), 2))
  }
  if (length(rows)) result$tables$sensitivity <<- rows
}

# Firth's penalised-likelihood logistic regression (Jeffreys prior), written out so no further package is needed. When an
# exposed or unexposed group has few or no events, maximum likelihood diverges (odds ratios of 1e-5 or 1e+50); the
# penalised estimate stays finite and is the standard remedy for sparse data.
firth_logit <- function(formula, data, max_iter = 100) {
  x <- model.matrix(formula, data); y <- data$outcome
  beta <- rep(0, ncol(x)); beta[1] <- qlogis((sum(y) + 0.5) / (length(y) + 1))
  for (iteration in seq_len(max_iter)) {
    p <- plogis(drop(x %*% beta)); w <- p * (1 - p)
    xw <- x * sqrt(w); information <- crossprod(xw); inverse <- solve(information)
    hat <- rowSums((xw %*% inverse) * xw)
    score <- crossprod(x, y - p + hat * (0.5 - p))
    step <- drop(inverse %*% score)
    largest <- max(abs(step)); if (largest > 5) step <- step * 5 / largest
    beta <- beta + step
    if (max(abs(step)) < 1e-8) break
  }
  p <- plogis(drop(x %*% beta)); w <- p * (1 - p)
  list(coefficients = setNames(beta, colnames(x)), vcov = solve(crossprod(x * sqrt(w))), converged = max(abs(step)) < 1e-6)
}
add_sparse_data_estimate <- function() {
  if (outcome_type != "binary" || !("exposure" %in% names(d)) || !exposure_binary) return(invisible(NULL))
  events <- tapply(d$outcome, d$exposure, sum)
  if (length(events) < 2) return(invisible(NULL))
  main <- Filter(function(e) identical(e$measure, "odds_ratio") && !grepl("sensitivity|Firth", e$label), result$estimates)
  degenerate <- length(main) > 0 && any(vapply(main, function(e) is.null(e$estimate) || is.na(e$estimate) || e$estimate < 0.01 || e$estimate > 100 || is.na(e$ci_low) || is.na(e$ci_high) || e$ci_high / max(e$ci_low, 1e-300) > 1e6, logical(1)))
  if (!(min(events) < 10 || degenerate || length(main) == 0)) return(invisible(NULL))
  fit <- firth_logit(as.formula(paste("outcome ~ exposure", if (length(covariates)) paste("+", rhs(covariates)) else "")), d)
  est <- fit$coefficients[["exposure"]]; se <- sqrt(fit$vcov["exposure", "exposure"])
  add_estimate("exposure_firth", "odds_ratio", exp(est), exp(est - z * se), exp(est + z * se), 2 * pnorm(-abs(est / se)),
               sprintf("%s (Firth penalised likelihood, sparse data; %d events exposed / %d unexposed)", label_of("exposure"), events[["1"]], events[["0"]]))
  warn("A group has few events or the usual estimate diverged, so a Firth penalised-likelihood estimate is added; its interval is a Wald interval and wide.")
}

# ---------- dispatch ----------
methods <- list(
  "descriptive.summary" = function() run_descriptive("summary"),
  "descriptive.rates" = function() run_descriptive("rates"),
  "descriptive.stratified" = function() run_descriptive("stratified"),
  "regression.adjusted" = function() run_regression(),
  "regression.robust" = function() run_regression(robust = TRUE),
  "regression.modified_poisson" = function() run_regression(poisson_rr = TRUE),
  "regression.rcs" = function() run_rcs(),
  "regression.quartiles" = function() run_quartiles(),
  "tests.unadjusted" = function() run_group_test(),
  "treatment.iptw" = function() run_iptw(),
  "treatment.psm" = function() run_psm(),
  "survival.cox" = function() run_cox(),
  "survival.km_logrank" = function() run_km_logrank(),
  "survival.cox_iptw" = function() { w <- iptw(); balance(w, "balance.png", "Covariate balance before and after weighting"); run_cox(w, "IPTW") },
  "modification.interaction" = function() run_interaction(),
  "modification.stratified" = function() run_stratified(),
  "modification.iptw_interaction" = function() run_interaction(weighted = TRUE),
  "mediation.mediate" = function() run_mediation("mediate"),
  "mediation.product" = function() run_mediation("product"),
  "mediation.difference" = function() run_mediation("difference"),
  "prediction.logistic" = function() run_prediction("logistic"),
  "prediction.lasso" = function() run_prediction("lasso"),
  "prediction.rcs" = function() run_prediction("rcs")
)

outcome <- tryCatch({
  method <- methods[[cfg$method_id]]
  if (is.null(method)) stop(paste0("Unknown method_id ", cfg$method_id))
  table_one()
  method()
  # A description has no effect estimate, so neither a sparse-data estimate nor an E-value applies.
  if (!describing) {
    tryCatch(add_sparse_data_estimate(), error = function(e) warn(paste0('The sparse-data estimate could not be computed: ', conditionMessage(e))))
    tryCatch(add_sensitivity(), error = function(e) NULL)
  }
  "completed"
}, error = function(e) { result$error <<- conditionMessage(e); "failed" })
result$status <- outcome
result$warnings <- I(unique(result$warnings))
if (!length(result$tables)) result$tables <- setNames(list(), character())
write_json(result, file.path(out_dir, "result.json"), auto_unbox = TRUE, digits = NA, null = "null", na = "null", pretty = TRUE)
