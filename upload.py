"""
run `python upload.py --help` for usage

requires GitPython
"""
import argparse
import datetime
import os
import re
import git
import pywikibot

SUMMARY = "Updating {} ({} @ {})"
HEADER_COMMENT = "/* Uploaded from branch {}, commit {} */\n"
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


def upload(site: pywikibot.Site, text: str, page_title: str, summary: str):
    script_page = pywikibot.Page(site, page_title)
    script_page.text = text
    script_page.save(summary=summary)


def main():
    """The main function"""

    # Parse the arguments
    parser = argparse.ArgumentParser(prog="upload.py",
            description="Upload reply-link")
    parser.add_argument("-t", "--test", action="store_true",
            help="Upload to testwiki (default: upload to enwiki)")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("-d", "--dev", action="store_true",
            help="On the wiki, filename will have a -dev suffix")
    group.add_argument("-b", "--both", action="store_true",
            help="Upload to both main & dev versions")
    args = parser.parse_args()

    wiki = "test" if args.test else "en"

    site = pywikibot.Site(wiki, "wikipedia")
    site.login()
    username = site.user()
    script_root = "User:{}/{}".format(username, SCRIPT_NAME)
    title = script_root + ("-dev" if args.dev else "") + ".js"
    print("Uploading to {} on {}.wikipedia.org...".format(title, wiki))

    local_script = SCRIPT_NAME + ".js"
    print("Reading from {}...".format(local_script))
    with open(local_script, "r") as target_file:
        branch, sha1 = get_branch_and_hash()
        summary = SUMMARY.format(local_script, sha1[:7], branch)
        text = HEADER_COMMENT.format(branch, sha1[:7]) + target_file.read()
        upload(site, text, title, summary)
        if args.both:
            upload(site, text, script_root + "-dev.js", summary)

    if not args.test and not args.dev:
        update_doc_time(site, script_root)


if __name__ == "__main__":
    main()
