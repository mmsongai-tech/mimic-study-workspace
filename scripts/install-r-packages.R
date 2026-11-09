#!/usr/bin/env Rscript
# Installs the R packages the statistical methods use (backend/src/study-analysis/runtimes/r/study_methods.R).
# survival and splines ship with R; the rest come from CRAN. Safe to run again: only missing packages are installed.
needed <- c("jsonlite", "survival", "glmnet", "mediation", "mice", "pROC", "sandwich", "MASS", "nlme")
repos <- getOption("repos"); if (is.null(repos) || identical(unname(repos["CRAN"]), "@CRAN@")) options(repos = c(CRAN = "https://cloud.r-project.org"))
missing <- needed[!vapply(needed, requireNamespace, logical(1), quietly = TRUE)]
# On Linux the system library is usually not writable by a normal user, and a non-interactive install.packages() then stops:
# use the personal library R already searches (R_LIBS_USER) instead.
lib <- .libPaths()[1]
if (file.access(lib, 2) != 0) { lib <- path.expand(Sys.getenv("R_LIBS_USER")); dir.create(lib, recursive = TRUE, showWarnings = FALSE); .libPaths(c(lib, .libPaths())) }
if (length(missing)) { message("Installing into ", lib, ": ", paste(missing, collapse = ", ")); install.packages(missing, lib = lib) }
still <- needed[!vapply(needed, requireNamespace, logical(1), quietly = TRUE)]
if (length(still)) { message("Could not install: ", paste(still, collapse = ", ")); quit(status = 1) }
message("R packages ready: ", paste(needed, collapse = ", "))
