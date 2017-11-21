import pywikibot
import sys

if len(sys.argv) < 1:
    print("usage: {} [SUMMARY] [--test]".format(sys.argv[0]))
    print("  SUMMARY (optional): Some text to be included in the upload edit summary.")
    print("  --test: If included, uploads to testwiki instead.")
    sys.exit(0)

lang = "en"

if "--test" in sys.argv:
    lang = "test"
    sys.argv.remove("--test")

wiki = pywikibot.Site(lang, "wikipedia")
wiki.login()
username = wiki.user()
print("Logged in as {}.".format(username))

filename = "reply-link.js"
print("Filename is {0}; will read from {0} and upload to User:{1}/{0}".format(filename, username))

summary_extra = sys.argv[2] if len(sys.argv) == 3 else ''

with open(filename, "r") as the_file:
    page = pywikibot.Page(wiki, "User:{}/{}".format(username, filename))
    page.text = the_file.read()
    print("Read local file. Uploading...")
    summary = "Updating script with local version"
    if summary_extra:
        summary += " - " + summary_extra
    page.save(summary)
