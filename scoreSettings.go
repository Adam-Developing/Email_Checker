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

// MaxScore returns the highest possible total score.
func MaxScore() float64 {
	// The maximum score is the highest possible domain score plus all other positive checks.
	var maxDomainScore = 0
	var otherPositiveScores = 0

	for _, c := range AllChecks {
		// Find the highest positive impact among domain-related checks
		if c.Name == "DomainExactMatch" || c.Name == "DomainNoSimilarity" || c.Name == "freeMailMatch" {
			if c.Impact > maxDomainScore {
				maxDomainScore = c.Impact
			}
		} else { // Sum other positive checks
			if c.Impact > 0 {
				otherPositiveScores += c.Impact
			}
		}
	}
	return float64(maxDomainScore + otherPositiveScores)
}
