"""
run `python upload.py --help` for usage

requires GitPython
"""
import argparse
import base64
import datetime
import getpass
import os
import re
import git
import pywikibot

SUMMARY = "Updating {} ({} @ {})"
SCRIPT_NAME = "reply-link"


def get_branch_and_hash():
    """Gets the branch that the repo is currently on, as well as the hash
    of the most recent commit to it"""
    repo = git.Repo(os.getcwd())
    branch, sha1 = "", ""
    try:
        branch = repo.active_branch
        sha1 = branch.commit.hexsha
    except AttributeError:
        branch = next(x for x in repo.branches if x.name == repo.active_branch)
        sha1 = branch.commit.id
    return branch, sha1


def update_doc_time(site: pywikibot.Site, script_root: str):
    """Update the time on the docs."""
    print("Updating script documentation page.")
    page = pywikibot.Page(site, title="User:Enterprisey/" + SCRIPT_NAME)
    docs_wikitext = page.get()
    date = re.search(r"start date and age\|\d+\|\d+\|\d+",
            docs_wikitext).group(0)
    now = datetime.datetime.now()
    revised_date = "start date and age|%d|%d|%d" %\
            (now.year, now.month, now.day)
    page.text = docs_wikitext.replace(date, revised_date)
    def save_callback(_page, e):
        if e:
            print("Error updating the \"updated\" time: " + str(e))
        else:
            print("Success! Updated the \"updated\" time on the documentation")
    page.save(summary="Updating {} \"updated\" time".format(SCRIPT_NAME),
            callback=save_callback)


def main():
    """The main function"""

    # Parse the arguments
    parser = argparse.ArgumentParser(prog="upload.py",
            description="Upload reply-link")
    parser.add_argument("-t", "--test", action="store_true",
            help="Upload to testwiki (default: upload to enwiki)")
    parser.add_argument("-d", "--dev", action="store_true",
            help="On the wiki, filename will have a -dev suffix")
    args = parser.parse_args()

    wiki = "test" if args.test else "en"

    site = pywikibot.Site(wiki, "wikipedia")
    site.login()
    username = site.user()
    script_root = "User:{}/{}".format(username, SCRIPT_NAME)
    title = script_root + ("-dev" if args.dev else "") + ".js"
    print("Uploading to {} on {}.wikipedia.org...".format(title, wiki))
    script_page = pywikibot.Page(site, title=title)

    local_script = SCRIPT_NAME + ".js"
    print("Reading from {}...".format(local_script))
    with open(local_script, "r") as target_file:
        script_page.text = target_file.read()
        branch, sha1 = get_branch_and_hash()
        def save_callback(_page, e):
            if not e:
                print("Successfully uploaded {}!".format(SCRIPT_NAME))

                # If this was the main update script, update the docs
                if wiki == "en" and not args.dev:
                    update_doc_time(site, script_root)
        script_page.save(summary=SUMMARY.format(local_script,
                sha1[:7], branch), callback=save_callback)


if __name__ == "__main__":
    main()
