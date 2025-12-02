package main

// Check represents one atomic verification with its possible score outcomes.
type Check struct {
	Name        string // unique identifier
	Description string // human‑readable summary
	Impact      int    // score when the check passes/fails
}

// AllChecks is the full list of checks in our pipeline.
var AllChecks = []Check{
	{
		Name:        "DomainExactMatch",
		Description: "Sender domain exactly matches a known good entry",
		Impact:      +30,
	},
	{
		Name:        "DomainNoSimilarity",
		Description: "Sender domain not in database and no close matches",
		Impact:      +17,
	},
	{
		Name:        "DomainImpersonation",
		Description: "Sender domain similar to a known domain (likely impersonation)",
		Impact:      0,
	},
	{
		Name:        "freeMailMatch",
		Description: "Sender is from a freeMail (e.g., Gmail, Outlook) which is not professional for business",
		Impact:      +12,
	},
	{
		Name:        "CompanyIdentified",
		Description: "NLP (Gemini) successfully identifies claimed company",
		Impact:      3,
	},
	{
		Name:        "CompanyVerified",
		Description: "Verified that the sender’s domain matches the company they claim",
		Impact:      20,
	},
	{
		Name:        "RealismCheck",
		Description: "Content judged realistic (no ludicrous offers or demands)",
		Impact:      25,
	},
	{
		Name:        "CorrectPhoneNumber",
		Description: "Phone number is valid and matches the company",
		Impact:      4,
	},
	{
		Name:        "MaliciousURLFound",
		Description: "A URL in the email was identified as malicious or suspicious",
		Impact:      10,
	},
	{
		Name:        "ExecutableFileFound",
		Description: "A file in the email was identified as an executable",
		Impact:      3,
	},
}

// MaxScoreFor calculates the maximum attainable score for the enabled checks map.
func MaxScoreFor(enabled map[string]bool) float64 {
	if enabled == nil {
		enabled = map[string]bool{}
	}

	total := 0
	if isEnabled(enabled, "checkDomain") {
		total += maxDomainImpact()
	}
	if isEnabled(enabled, "checkUrls") {
		total += positiveImpact("MaliciousURLFound")
	}
	if isEnabled(enabled, "checkAttachments") {
		total += positiveImpact("ExecutableFileFound")
	}
	if isEnabled(enabled, "checkTextAnalysis") || isEnabled(enabled, "checkRenderedAnalysis") {
		total += textAnalysisImpact()
	}
	return float64(total)
}

func isEnabled(enabled map[string]bool, key string) bool {
	val, ok := enabled[key]
	if !ok {
		return true
	}
	return val
}

func maxDomainImpact() int {
	maxScore := 0
	for _, name := range []string{"DomainExactMatch", "DomainNoSimilarity", "freeMailMatch"} {
		if impact := positiveImpact(name); impact > maxScore {
			maxScore = impact
		}
	}
	return maxScore
}

func textAnalysisImpact() int {
	sum := 0
	for _, name := range []string{"CompanyIdentified", "CompanyVerified", "RealismCheck", "CorrectPhoneNumber"} {
		sum += positiveImpact(name)
	}
	return sum
}

func positiveImpact(name string) int {
	for _, c := range AllChecks {
		if c.Name == name && c.Impact > 0 {
			return c.Impact
		}
	}
	return 0
}
