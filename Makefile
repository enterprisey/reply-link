.PHONY: test-upload
test-upload:
	eslint reply-link.js
	python upload.py --test
	notify-send 'Uploaded popups!'
