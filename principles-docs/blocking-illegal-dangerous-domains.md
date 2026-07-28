This method can be used, optionally but enabled by default, to allow a node to block a certain content if dangerous and overall illegal (but without moralism about legal content ;)

---

If your goal is to protect yourself from real threats (malware, scams, phishing) and strictly illegal content, without any "moral" filtering of your legal browsing habits, the best solution is to choose a security-only DNS or a highly customizable one.

Here are the two best options for achieving this:

### 1. "Set and Forget" DNS (Security Only)

These DNS servers protect you from known cyber threats, but allow any adult content that isn't infected to pass through.

* **Cloudflare Security (`1.1.1.2` and `1.0.0.2`):**
Not to be confused with 1.1.1.3 (which blocks porn). Cloudflare's `.2` version filters out **exclusively malware and phishing sites**. It doesn't apply any content-based censorship, so legal adult sites will work perfectly, as long as they don't distribute viruses.
* **Quad9 (`9.9.9.9` and `149.112.112.112`):**
As mentioned before, its sole purpose is to block sites hosting malware, botnets, or scams. Again, no moralizing here: traffic to hardcore sites passes without problems, as long as the destination server is "clean" in terms of cybersecurity.

### 2. Surgical Control (NextDNS)

If you want the absolute guarantee of blocking child pornography (CSAM) and malware, but want to ensure nothing else is touched, the ultimate solution is **NextDNS** (or similar services like ControlD).

NextDNS works like your own private DNS server in the cloud and lets you choose *exactly* what to block via a control panel:

* **You can activate basic protection:** Check the options to block malware, cryptojacking, and scam sites.

* **You can enable the legal/CSAM filter:** You can enable specific lists (such as those from the *Internet Watch Foundation*) that only block domains known to host child pornography and abuse.
* **You can leave the moral filter off:** Simply leave the "Pornography" or "Adult Content" toggle off.

This way, you create a custom configuration that does exactly what you asked for: it blocks what is objectively illegal or dangerous for your computer, and leaves the rest completely free.