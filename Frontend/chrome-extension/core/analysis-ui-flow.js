import { initializeUI, streamAnalysis } from './analysis-core.js';

export async function handleAnalysisFlow(getEmlDataPromise, settings, uiElements, hideInitialUI, sessionId, abortController) {
    const { statusElement, spinnerElement, resultsContainer, statusContainer } = uiElements;
    try {
        // 1. Set up the initial UI for analysis
        hideInitialUI();
        if (statusContainer) statusContainer.style.display = "flex";
        if (statusElement) statusElement.innerText = "Starting analysis...";
        const effectiveSettings = settings || {};
        if (resultsContainer) initializeUI(resultsContainer.id, sessionId, effectiveSettings);

        // 2. Fetch the EML data using the provided function
        if (statusElement) statusElement.innerText = "Fetching email data...";
        const finalEmlToSend = await getEmlDataPromise();

        // 3. Perform the streaming analysis
        if (statusElement) statusElement.innerText = "Analyzing ...";
        if (spinnerElement) spinnerElement.style.display = "block";

        // Pass settings to streamAnalysis
        await streamAnalysis(finalEmlToSend, settings, {
            signal: abortController?.signal,
            sessionId,
        });

        // 4. Finalize the UI
        if (spinnerElement) spinnerElement.style.display = "none";
        if (statusElement) statusElement.innerText = "Analysis complete.";

    } catch (error) {
        // Don't show error UI when the analysis was intentionally aborted (user navigated away)
        if (error.name === 'AbortError') {
            console.log('Analysis aborted (user navigated away).');
            return;
        }
        // Universal error handling for real errors
        if (spinnerElement) spinnerElement.style.display = "none";
        if (statusElement) statusElement.innerText = `Error: ${error.message}`;
        console.error(error);
        if (resultsContainer) resultsContainer.innerHTML = `<p style="color: red;">An error occurred during analysis. Please try again.</p>`;
    }
}