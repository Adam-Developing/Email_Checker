import { handleAnalysisFlow } from './core/analysis-ui-flow.js';

function getEmlData(eml) {
    return new Promise((resolve) => {
        resolve(eml);
    });
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'EML_DATA') {
        const uiElements = {
            statusElement: document.getElementById("item-subject"),
            spinnerElement: document.getElementById("analysis-spinner"),
            resultsContainer: document.getElementById("results-container"),
            statusContainer: document.getElementById("analysis-status-container")
        };

        handleAnalysisFlow(async () => getEmlData(request.eml), uiElements, () => {});
    }
});