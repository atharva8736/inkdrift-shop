# Getting paid with your UPI ID (free, no server)

How it works
1. Customer clicks Pay. The shop shows your UPI ID, a QR code and the exact amount.
2. They pay in PhonePe / GPay / Paytm. The money goes straight to your bank account.
3. They type the 12-digit UTR (bank reference) from their payment receipt.
4. You open https://inkdrift-shop-fvfb.vercel.app/admin.html, check your UPI app history for the same amount and UTR, and press Approve.
5. Their download unlocks. A UTR can only be used once.

Set-up (Vercel -> your project -> Settings -> Environment Variables, Production)
- UPI_ID = your UPI ID (example: nidhi@okhdfcbank)
- UPI_PAYEE_NAME = Inkdrift
- ADMIN_EMAILS = the email you log in to the shop with
Then redeploy. Remove YOUPI_API_URL if it is set (it switches the shop to the automatic gateway).

Test: buy one wallpaper yourself with a coupon or the smallest item, pay yourself from another UPI app, submit the UTR, approve it in /admin.html.

Later, to make it automatic, see the YOUPI section of the README.

## Deadlines and the admin page
- An order nobody pays expires after 60 minutes (`MANUAL_UPI_PAY_WINDOW_MINUTES`).
- A submitted UTR you never checked expires after 48 hours (`MANUAL_UPI_VERIFY_DEADLINE_HOURS`). You can still approve it later if the money really arrived.
- /admin.html has four tabs: Needs your check, Waiting for payment, Verified, Failed / expired, with UTR, order, customer, amount and times.
- Automatic UTR verification is not possible with a personal UPI ID. It needs a payment gateway (for example PhonePe Payment Gateway) so the shop is told by a signed webhook.
