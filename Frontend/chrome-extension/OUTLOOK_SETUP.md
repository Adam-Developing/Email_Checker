# Microsoft Outlook Web Integration Setup Guide

This guide explains how to configure the Email Spam Detector extension to work with Microsoft Outlook web (outlook.live.com, outlook.office365.com, outlook.office.com).

## Overview

The extension now supports both Gmail and Microsoft Outlook web email services. Outlook support uses the Microsoft Graph API to fetch emails in MIME format, which is then analyzed by the backend server in the same way as Gmail emails.

## Prerequisites

- A Microsoft Azure account (free tier is sufficient)
- The Email Spam Detector extension files
- Backend server running on `http://127.0.0.1:8080`

## Step 1: Register an Application in Azure Portal

1. **Go to Azure Portal**
   - Navigate to [Azure Portal](https://portal.azure.com/)
   - Sign in with your Microsoft account

2. **Register a new application**
   - Go to **Azure Active Directory** (or **Microsoft Entra ID**)
   - Click on **App registrations** in the left sidebar
   - Click **+ New registration**

3. **Configure application settings**
   - **Name**: Enter a name like "Email Spam Detector Extension"
   - **Supported account types**: Select "Accounts in any organizational directory and personal Microsoft accounts"
   - **Redirect URI**: 
     - Select "Single-page application (SPA)" as platform type
     - Enter: `https://<extension-id>.chromiumapp.org/` (you'll update this later)
   - Click **Register**

4. **Note your Application (client) ID**
   - On the Overview page, copy the **Application (client) ID**
   - You'll need this for the manifest configuration

## Step 2: Configure API Permissions

1. **Navigate to API permissions**
   - In your app registration, click **API permissions** in the left sidebar
   - Click **+ Add a permission**

2. **Add Microsoft Graph permissions**
   - Select **Microsoft Graph**
   - Choose **Delegated permissions**
   - Search for and add these permissions:
     - `Mail.Read` - Read user mail
     - `offline_access` - Maintain access to data
   - Click **Add permissions**

3. **Grant admin consent (optional)**
   - If you're in an organization, you may need admin consent
   - Click **Grant admin consent for [Your Organization]**

## Step 3: Configure Authentication

1. **Go to Authentication**
   - In your app registration, click **Authentication** in the left sidebar

2. **Configure platform settings**
   - Under **Single-page application**, ensure your redirect URI is listed
   - Under **Implicit grant and hybrid flows**:
     - Check ✅ **Access tokens (used for implicit flows)**
     - Check ✅ **ID tokens (used for implicit and hybrid flows)**

3. **Save your changes**

## Step 4: Load Extension and Get Extension ID

1. **Load the extension in Chrome**
   - Open Chrome and go to `chrome://extensions/`
   - Enable **Developer mode** (toggle in top-right corner)
   - Click **Load unpacked**
   - Select the `Frontend/chrome-extension` directory

2. **Copy the Extension ID**
   - Find the Email Spam Detector extension in the list
   - Copy the **ID** (it looks like: `abcdefghijklmnopqrstuvwxyzabcdef`)

## Step 5: Update Azure Redirect URI

1. **Go back to Azure Portal**
   - Navigate to your app registration
   - Go to **Authentication**

2. **Update the redirect URI**
   - Under **Single-page application**, click on your redirect URI
   - Update it to: `https://<your-extension-id>.chromiumapp.org/`
   - For example: `https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/`
   - Click **Save**

## Step 6: Configure Extension Manifest

1. **Copy manifest.example.json to manifest.json** (if not already done)
   ```bash
   cd Frontend/chrome-extension
   cp manifest.example.json manifest.json
   ```

2. **Edit manifest.json**
   - Open `manifest.json` in a text editor
   - Find the `outlook_oauth2` section
   - Replace `YOUR_MICROSOFT_CLIENT_ID_HERE` with your Application (client) ID from Step 1

   ```json
   "outlook_oauth2": {
     "client_id": "YOUR_ACTUAL_CLIENT_ID_HERE",
     "scopes": [
       "Mail.Read",
       "offline_access"
     ]
   }
   ```

3. **Save the file**

## Step 7: Reload Extension

1. **Reload the extension**
   - Go back to `chrome://extensions/`
   - Find the Email Spam Detector extension
   - Click the **Reload** button (circular arrow icon)

## Step 8: Test Outlook Integration

1. **Ensure backend server is running**
   ```bash
   cd Backend
   go run .
   ```

2. **Open Outlook web**
   - Navigate to one of the supported Outlook URLs:
     - [https://outlook.live.com](https://outlook.live.com)
     - [https://outlook.office365.com](https://outlook.office365.com)
     - [https://outlook.office.com](https://outlook.office.com)

3. **Open an email**
   - Click on any email to view it
   - The extension should detect the email and display a score circle

4. **Authenticate (first time)**
   - Click the score circle (it may show "Auth!")
   - Click **Authenticate** in the modal
   - Sign in with your Microsoft account
   - Grant the requested permissions
   - The extension will fetch and analyze the email

## Supported Outlook URLs

The extension is configured to work with these Outlook web URLs:

- **Outlook.com (Personal)**: `https://outlook.live.com/*`
- **Office 365**: `https://outlook.office365.com/*`
- **Office 365 (Modern)**: `https://outlook.office.com/*`

## Troubleshooting

### Extension not working on Outlook

**Problem**: Score circle doesn't appear
- **Solution**: Check browser console (F12) for errors
- Verify the content script is injected (check `chrome://extensions/`)
- Ensure you're on a supported Outlook URL

### Authentication failing

**Problem**: "Auth flow failed" or "AUTH_REQUIRED" errors
- **Solution**: 
  - Verify Application (client) ID is correct in manifest.json
  - Check that redirect URI in Azure matches your extension ID exactly
  - Ensure API permissions are granted in Azure Portal
  - Try clearing the extension's auth cache in chrome://extensions/ (click "Remove")

### "Outlook OAuth not configured" error

**Problem**: Error message about OAuth not configured
- **Solution**: 
  - Ensure `outlook_oauth2` section exists in manifest.json
  - Verify `client_id` is filled in (not the placeholder text)
  - Reload the extension after making changes

### "Microsoft Graph API Error: 401" or "403"

**Problem**: Authorization errors from Microsoft Graph API
- **Solution**:
  - Re-authenticate by clicking "Auth!" in the extension
  - Check that `Mail.Read` permission is granted in Azure Portal
  - Ensure your Microsoft account has access to the mailbox

### Emails not analyzing

**Problem**: Score circle appears but stays in "loading" state
- **Solution**:
  - Check that backend server is running on port 8080
  - Verify `http://127.0.0.1:8080/` is in host_permissions
  - Check backend logs for errors
  - Verify email was successfully fetched (check browser console)

## Security Considerations

- **Permissions**: The extension only requests `Mail.Read` permission, providing read-only access to your emails
- **Token Storage**: Authentication tokens are handled by Chrome's identity API and not stored permanently
- **Data Privacy**: Email data is sent to your local backend server (localhost:8080), not to any third-party servers
- **OAuth Flow**: Uses industry-standard OAuth 2.0 for secure authentication

## Limitations

- **New Outlook Desktop**: The web-based extension does not work with the Outlook desktop application, only with Outlook web interfaces
- **Email Format**: Requires emails to be accessible via Microsoft Graph API
- **Authentication**: Requires user to authenticate with Microsoft account on first use

## Additional Resources

- [Microsoft Graph API Documentation](https://docs.microsoft.com/en-us/graph/overview)
- [Azure App Registration Guide](https://docs.microsoft.com/en-us/azure/active-directory/develop/quickstart-register-app)
- [Chrome Extension Identity API](https://developer.chrome.com/docs/extensions/reference/identity/)

## Getting Help

If you encounter issues not covered in this guide:

1. Check the browser console for error messages (F12 → Console tab)
2. Review backend server logs
3. Verify all configuration steps were completed correctly
4. Open an issue on the GitHub repository with:
   - Error messages from browser console
   - Backend server logs (if applicable)
   - Steps to reproduce the issue
