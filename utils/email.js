const SibApiV3Sdk = require('sib-api-v3-sdk');

const sendEmail = async ({ to, subject, htmlContent, textContent }) => {
    try {
        const defaultClient = SibApiV3Sdk.ApiClient.instance;
        const apiKey = defaultClient.authentications['api-key'];
        apiKey.apiKey = process.env.BREVO_API_KEY;

        const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

        // Parse sender info
        let senderName = 'GroceryVoice';
        let senderEmail = 'noreply@example.com';
        const envFrom = process.env.EMAIL_FROM;

        if (envFrom) {
            if (envFrom.includes('<')) {
                const match = envFrom.match(/"?([^"<]+)"?\s*<([^>]+)>/);
                if (match) {
                    senderName = match[1].trim();
                    senderEmail = match[2].trim();
                } else {
                    // Fallback if parsing fails but < exists
                    senderEmail = envFrom.replace(/[<>]/g, '');
                }
            } else {
                senderEmail = envFrom.trim();
            }
        }

        sendSmtpEmail.sender = { name: senderName, email: senderEmail };
        sendSmtpEmail.to = [{ email: to }];
        sendSmtpEmail.subject = subject;
        sendSmtpEmail.htmlContent = htmlContent;

        // Fallback text if not provided
        sendSmtpEmail.textContent = textContent || htmlContent.replace(/<[^>]*>?/gm, '');

        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log(`Email sent successfully to ${to}. Message ID: ${data.messageId}`);
        return data;
    } catch (error) {
        console.error('Error sending email:', error.response ? error.response.body : error.message);
        // Don't throw, just log. Email failure shouldn't crash the request in most cases.
        return null;
    }
};

module.exports = sendEmail;
