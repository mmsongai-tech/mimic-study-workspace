args <- commandArgs(trailingOnly=TRUE)
input <- read.csv(args[1]); output <- args[2]
if (!requireNamespace("survival", quietly=TRUE)) stop("survival package is required")
fit <- survival::coxph(survival::Surv(duration, event) ~ exposure, data=input, ties="efron")
coef <- summary(fit)$coefficients[1,]; ci <- tryCatch(survival::confint(fit)[1,], error=function(e) c(NA,NA))
z <- tryCatch(survival::cox.zph(fit)$table[1,"p"], error=function(e) NA_real_)
lines <- c(paste("events", sum(input$event), sep="\t"), paste("censored", sum(!input$event), sep="\t"), paste("total", nrow(input), sep="\t"), paste("hazard_ratio", exp(coef[["coef"]]), sep="\t"), paste("ci_lower", exp(ci[1]), sep="\t"), paste("ci_upper", exp(ci[2]), sep="\t"), paste("ph_p_value", z, sep="\t"), paste("converged", as.integer(isTRUE(fit$converged) || is.null(fit$converged)), sep="\t"))
writeLines(lines, output)
