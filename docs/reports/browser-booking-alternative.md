# Tokyo browser booking alternative (27 September 2026)

## Candidate: Rakuten GURUNAVI, Osusumeya Ueno

Official restaurant URL: https://gurunavi.com/en/gf8v400/rst/

This Ueno izakaya is a plausible **table-only** alternative for two adults on **28 September 2026 at 19:00 JST**. Its official listing says it is open Monday dinner 17:00–23:15, gives a dinner average of **¥2,000 per person**, advertises “Free & Instant Reservation,” and explicitly says payment for a seat-only reservation is on the date of visit. The restaurant also offers a **¥2,000 per person course** with tax, service, and cover included, but that is a distinct course booking, not a table-only price guarantee. [Restaurant listing](https://gurunavi.com/en/gf8v400/rst/); [course details](https://gurunavi.com/en/gf8v400/mn/course1/1/rst/).

In a read-only inspection of the live official booking widget, selecting **28 September**, **2 guests**, and **19:00** enabled Continue and opened **“Verify your identity.”** The next screen required an email address. It said Gurunavi would send a link that the diner must tap, then enter contact information to complete the reservation. We stopped there: no email was entered, no account was used, and no reservation was submitted. Thus the visible 19:00 option establishes a plausible route at inspection time, not a held table or confirmed booking. A login, OTP, phone country-code requirement, or payment request beyond this email-link step could not be ruled out because the subsequent form was not reached. [Restaurant booking widget](https://gurunavi.com/en/gf8v400/rst/).

Gurunavi’s [table-reservation FAQ](https://gurunavi.com/en/site/faq/table-reservations/) says table bookings take orders on arrival and cannot be paid in advance; a completed booking generates an email with a reservation number and a link to its management page. Its [seat-only terms](https://gurunavi.com/en/site/legal/) say the reservation is established only when the prescribed process is completed and a completion email is then sent. Consequently, HumanOS should treat the email verification and final completion as user-dependent gates and report success only after a completion confirmation is observed. Do not interpret “Free & Instant” as confirmation from the availability picker alone.

The restaurant’s official cancellation policy lists **¥2,200 per person for same-day cancellation** of table reservations, including cancellation with notice, and ¥0 one day before. That possible fee exceeds the stated ¥2,000 per-person dining budget; the user should see this exact policy before confirmation. The restaurant listing also says heat-not-burn smoking is allowed at all seats. [Restaurant listing](https://gurunavi.com/en/gf8v400/rst/).

## Integration implication

Gurunavi is a stronger budget fit than the premium OpenTable Tokyo listings inspected, but this is a **conditional** recommendation. A Browser Use implementation can navigate to the official listing and select the requested date, party size, and time, then pause at the email-link verification and later inspect the final details and completion email. No automation reliability, absence of later identity/payment steps, or successful booking is established by this research.
