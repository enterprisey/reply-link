"""
Usage:
python upload.py [--test]

--test, if specified, uploads to testwiki not enwiki.
"""
import getpass
import git
import re
import os
import sys
import wikitools
import base64

API_ENTRY_POINT = "https://%s.wikipedia.org/w/api.php"
SUMMARY = "Updating {} ({} @ {})"
SCRIPT = "reply-link.js"
USERNAME = "Enterprisey"

def get_branch_and_hash():
    repo = git.Repo(os.getcwd())
    branch, sha1 = "", ""
    try:
        branch = repo.active_branch
        sha1 = branch.commit.hexsha
    except AttributeError:
        branch = next(x for x in repo.branches if x.name == repo.active_branch)
        sha1 = branch.commit.id
    return branch, sha1

def main():
    wiki = "test" if (len(sys.argv) > 1 and sys.argv[1] == "--test") else "en"
    title = "User:Enterprisey/" + SCRIPT

    print("Uploading to {} on {}.wikipedia.org...".format(title, wiki))

    site = wikitools.Wiki(API_ENTRY_POINT % wiki)
    password = ""
    if not password:
        password = getpass.getpass("Password for %s on %s.wikipedia.org: " % (USERNAME, wiki))
    site.login(USERNAME, password)
    source = wikitools.Page(site, title=title)

    print("Reading from {}...".format(SCRIPT))
    with open(SCRIPT, "r") as target_file:
        file_text = target_file.read()
        branch, sha1 = get_branch_and_hash()
        summary = SUMMARY.format(SCRIPT, sha1[:7], branch)
        result = source.edit(text=file_text, summary=summary)
        if "edit" in result and result["edit"]["result"] == "Success":
            print("Successfully uploaded popups!")

if __name__ == "__main__":
    main()
