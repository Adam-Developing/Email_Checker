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
		Impact:      +40,
	},
	{
		Name:        "DomainNoSimilarity",
		Description: "Sender domain not in database and no close matches",
		Impact:      +40,
	},
	{
		Name:        "DomainImpersonation",
		Description: "Sender domain similar to a known domain (likely impersonation)",
		Impact:      -40,
	},
	{
		Name:        "CompanyIdentified",
		Description: "NLP (Gemini) successfully identifies claimed company",
		Impact:      25,
	},
	{
		Name:        "CompanyVerified",
		Description: "Verified that the sender’s domain matches the company they claim",
		Impact:      25,
	},
	{
		Name:        "RealismCheck",
		Description: "Content judged realistic (no ludicrous offers or demands)",
		Impact:      25,
	},
}

// MaxScore returns the highest possible total score.
func MaxScore() float64 {
	maxCounter := 0
	for _, c := range AllChecks {
		if c.Impact > 0 {
			maxCounter += c.Impact
		}
	}
	return float64(maxCounter - 40)
}
