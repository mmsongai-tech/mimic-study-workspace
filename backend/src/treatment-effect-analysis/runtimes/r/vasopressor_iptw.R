args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 4) stop("expected input, output, balance figure, effects figure")
data <- read.csv(args[[1]], stringsAsFactors = FALSE)
required <- c("subject_id", "treated", "outcome", "age_years", "sofa_score", "baseline_lactate", "sex")
if (!all(required %in% names(data))) stop("missing required columns")
complete <- complete.cases(data[, required]); d <- data[complete, ]
if (nrow(d) < 100 || length(unique(d$treated)) != 2) stop("insufficient treatment data")
d$sex_female <- as.integer(d$sex == "female")
model <- glm(treated ~ age_years + sofa_score + baseline_lactate + sex_female, data = d, family = binomial())
ps <- pmin(pmax(predict(model, type = "response"), 0.01), 0.99)
prevalence <- mean(d$treated)
weight <- ifelse(d$treated == 1, prevalence / ps, (1 - prevalence) / (1 - ps))
bounds <- quantile(weight, c(0.01, 0.99)); weight <- pmin(pmax(weight, bounds[[1]]), bounds[[2]])
weighted_mean <- function(x, w) sum(x*w)/sum(w)
risk_t <- weighted_mean(d$outcome[d$treated == 1], weight[d$treated == 1])
risk_u <- weighted_mean(d$outcome[d$treated == 0], weight[d$treated == 0])
rd <- risk_t - risk_u; rr <- risk_t / risk_u
effective_n <- sum(weight)^2 / sum(weight^2)
smd <- function(x, treated, w = rep(1, length(x))) {
  mt <- weighted_mean(x[treated == 1], w[treated == 1]); mu <- weighted_mean(x[treated == 0], w[treated == 0])
  vt <- weighted_mean((x[treated == 1] - mt)^2, w[treated == 1]); vu <- weighted_mean((x[treated == 0] - mu)^2, w[treated == 0])
  abs(mt - mu) / sqrt((vt + vu)/2)
}
covariates <- list(age = d$age_years, sofa = d$sofa_score, lactate = d$baseline_lactate, female = d$sex_female)
before <- sapply(covariates, smd, treated = d$treated)
after <- sapply(covariates, smd, treated = d$treated, w = weight)
bootstrap_rd <- function(indices) {
  b <- d[indices, ]; fit <- suppressWarnings(glm(treated ~ age_years + sofa_score + baseline_lactate + sex_female, data = b, family = binomial()))
  p <- pmin(pmax(predict(fit, type = "response"), 0.01), 0.99); prev <- mean(b$treated)
  w <- ifelse(b$treated == 1, prev/p, (1-prev)/(1-p)); limits <- quantile(w, c(0.01,0.99)); w <- pmin(pmax(w,limits[[1]]),limits[[2]])
  weighted_mean(b$outcome[b$treated==1],w[b$treated==1])-weighted_mean(b$outcome[b$treated==0],w[b$treated==0])
}
set.seed(20260831)
bootstrap_estimates <- replicate(300, bootstrap_rd(sample.int(nrow(d), nrow(d), replace=TRUE)))
ci <- quantile(bootstrap_estimates[is.finite(bootstrap_estimates)], c(0.025,0.975))
writeLines(c(
  paste("r_version", paste(R.version$major, R.version$minor, sep = "."), sep = "\t"), paste("total", nrow(d), sep = "\t"),
  paste("treated", sum(d$treated), sep = "\t"), paste("untreated", sum(!d$treated), sep = "\t"),
  paste("treated_events", sum(d$outcome[d$treated == 1]), sep = "\t"), paste("untreated_events", sum(d$outcome[d$treated == 0]), sep = "\t"),
  paste("missing_records", nrow(data)-nrow(d), sep = "\t"), paste("risk_treated", risk_t, sep = "\t"), paste("risk_untreated", risk_u, sep = "\t"),
  paste("risk_difference", rd, sep = "\t"), paste("risk_ratio", rr, sep = "\t"), paste("ci_lower", ci[[1]], sep = "\t"), paste("ci_upper", ci[[2]], sep = "\t"),
  paste("converged", as.integer(model$converged), sep = "\t"), paste("max_smd_before", max(before), sep = "\t"), paste("max_smd_after", max(after), sep = "\t"),
  paste("effective_sample_size", effective_n, sep = "\t"), paste("extreme_weight_fraction", mean(weight >= bounds[[2]]), sep = "\t"),
  paste("bootstrap_replicates", length(bootstrap_estimates), sep = "\t"),
  paste("smd_before", paste(sprintf("%.4f", before), collapse = ","), sep = "\t"), paste("smd_after", paste(sprintf("%.4f", after), collapse = ","), sep = "\t")
), args[[2]])
ys <- c(110,170,230,290); labels <- c("Age","SOFA","Lactate","Female")
marks <- paste(mapply(function(y,b,a,l) paste0('<text x="20" y="',y+5,'" font-family="sans-serif" font-size="14">',l,'</text><line x1="',120+450*b,'" y1="',y,'" x2="',120+450*a,'" y2="',y,'" stroke="#aaa"/><circle cx="',120+450*b,'" cy="',y,'" r="7" fill="#c79020"/><circle cx="',120+450*a,'" cy="',y,'" r="7" fill="#0b806a"/>'), ys, before, after, labels), collapse="")
balance <- paste0('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="380"><rect width="700" height="380" fill="white"/><text x="350" y="35" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#173b33">Covariate balance before and after IPTW</text><line x1="165" y1="70" x2="165" y2="330" stroke="#999" stroke-dasharray="5"/>', marks, '</svg>')
writeLines(balance, args[[3]])
effects <- paste0('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="360"><rect width="700" height="360" fill="white"/><text x="350" y="35" text-anchor="middle" font-family="sans-serif" font-size="22" fill="#173b33">IPTW-weighted mortality risk</text><rect x="170" y="',300-220*risk_t,'" width="130" height="',220*risk_t,'" fill="#0b806a"/><rect x="400" y="',300-220*risk_u,'" width="130" height="',220*risk_u,'" fill="#89bdb1"/><text x="235" y="330" text-anchor="middle" font-family="sans-serif">Early vasopressor</text><text x="465" y="330" text-anchor="middle" font-family="sans-serif">No early vasopressor</text></svg>')
writeLines(effects, args[[4]])
