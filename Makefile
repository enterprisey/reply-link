.PHONY: test-upload
test-upload:
	eslint reply-link.js
	pwb upload.py --test
	notify-send 'Uploaded popups!'
