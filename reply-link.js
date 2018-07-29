//<nowiki>
function loadReplyLink( $, mw ) {
    var TIMESTAMP_REGEX = /\(UTC(?:(?:−|\+)\d+?(?:\.\d+)?)?\)\S*?$/m;
    var SIGNATURE = "~~" + "~~"; // split up because it might get processed

    /**
     * This dictionary is some global state that holds three pieces of
     * information for each "(reply)" link (represented by their unique
     * IDs):
     *
     *  - the indentation string for the comment (e.g. ":*::")
     *  - the header tuple for the parent section, in the form of
     *    [level, text, number], where:
     *      - level is 1 for a h1, 2 for a h2, etc
     *      - text is the text between the equal signs
     *      - number is the zero-based index of the heading from the top
     *  - sigIdx, or the zero-based index of the signature from the top
     *    of the section
     *
     * This dictionary is populated in attachLinks and used in the click
     * handler for the links, which is defined in attachLinkAfterNode.
     */
    var metadata = {};

    /**
     * This global string flag is:
     *
     *  - "AfD" if the current page is an AfD page
     *  - "MfD" if the current page is an MfD page
     *  - "TfD" if the current page is a TfD log page
     *  - "CfD" if the current page is a CfD log page
     *  - "FfD" if the current page is a FfD log page
     *  - "" otherwise
     *
     * This flag is initialized in onReady and used in attachLinkAfterNode
     */
    var xfdType;

    /**
     * This function converts any (index-able) iterable into a list.
     */
    function iterableToList( nl ) {
        var arr = new Array( nl.length );
        for(var i=-1,l=nl.length;++i!==l;arr[i]=nl[i]);
        return arr;
    }

    /**
     * When there's a panel being shown, this function sets the status
     * in the panel to the first argument. The callback function is
     * optional.
     */
    function setStatus ( status, callback ) {
        var statusElement = $( "#reply-dialog-status" );
        statusElement.fadeOut( function () {
            statusElement.html( status ).fadeIn( callback );
        } );
    }

    /**
     * Finds and returns the div that is the immediate parent of the
     * first talk page header on the page, so that we can read all the
     * sections by iterating through its child nodes.
     */
    function findMainContentEl() {

        // The element itself will be the text span in the h2; its
        // parent will be the h2; and the parent of the h2 is the
        // content container that we want
        return document.querySelector( "span.mw-headline" )
            .parentElement
            .parentElement;
    }

    /**
     * Given some wikitext, processes it to get just the text content.
     * This function should be identical to the MediaWiki function
     * that gets the wikitext between the equal signs and comes up
     * with the id's that anchor the headers.
     */
    function wikitextToTextContent( wikitext ) {
        return wikitext.replace( /\[\[:?(?:[^\|]+?\|)?([^\]\|]+?)\]\]/g, "$1" );
    }

    /**
     * Given some wikitext that's split into sections, return the full
     * wikitext (including header and newlines until the next header)
     * of the section with the given (zero-based) index.
     *
     * Performs a sanity check with the given section name.
     */
    function getSectionWikitext( dirtyWikitext, sectionIdx, sectionName ) {
        var HEADER_RE = /^\s*==(=*)\s*(.+?)\s*\1==\s*$/gm;

        //console.log("In getSectionWikitext, sectionIdx = " + sectionIdx + ", sectionName = >" + sectionName + "<");
        //console.log("wikitext (first 1000 chars) is " + dirtyWikitext.substring(0, 1000));

        // Parsing pitfall: we shouldn't recognize headers inside code
        // blocks, or collapse blocks, because MW doesn't either
        // So, replace both sorts of blocks with special keys
        var DELIMS_RE = /<pre>[\s\S]+?<\/pre>/g;
        var replacements = {}; // maps keys to blocks
        var delimsMatch;
        var wikitext = dirtyWikitext;
        var key;
        do {
            delimsMatch = DELIMS_RE.exec( dirtyWikitext );
            if( delimsMatch ) {
                if( HEADER_RE.test( delimsMatch[0] ) ) {
                    key = "%!%!%!" + ( Object.keys( replacements ).length ) + "!%!%!%";
                    wikitext = wikitext.replace( delimsMatch[0], key );
                    replacements[key] = delimsMatch[0];
                }
            }
        } while( delimsMatch );

        var startIdx = -1; // wikitext index of section start
        var endIdx = -1; // wikitext index of section end

        var headerCounter = 0;
        var headerMatch;

        do {
            headerMatch = HEADER_RE.exec( wikitext );
            if( headerMatch ) {
                console.log("Header " + headerCounter + " (idx " + headerMatch.index + "): >" + headerMatch[0] + "<");
                if( headerCounter === sectionIdx ) {
                    if( wikitextToTextContent( headerMatch[2] ) !== sectionName ) {
                        throw( "Sanity check on header name failed! Found \"" +
                                headerMatch[2] + "\", expected \"" +
                                sectionName + "\" (wikitext vs DOM)" );
                    }
                    startIdx = headerMatch.index;
                } else if( headerCounter - 1 === sectionIdx ) {
                    endIdx = headerMatch.index;
                    break;
                }
            }
            headerCounter++;
        } while( headerMatch );

        // If we encountered no section after the target section,
        // then the target was the last one and the slice will go
        // until the end of wikitext
        if( endIdx < 0 ) {
            console.log("[getSectionWikitext] endIdx negative, setting to " + wikitext.length);
            endIdx = wikitext.length;
        }

        //console.log("[getSectionWikitext] Slicing from " + startIdx + " to " + endIdx);
        var cleanSlice = wikitext.slice( startIdx, endIdx );

        // Now, inflate the blocks (if any) that we removed earlier
        var slice = cleanSlice;
        var KEY_RE = /%\!%\!%\!(\d+)\!%\!%\!%/g;
        var keyMatch;
        do {
            keyMatch = KEY_RE.exec( cleanSlice );
            if( keyMatch ) {
                slice = slice.replace( keyMatch[0], replacements[ keyMatch[0] ] );
            }
        } while( keyMatch );
        return slice;
    }

    /**
     * Converts a signature index to a string index into the given
     * section wikitext. For example, if sigIdx is 1, then this function
     * will return the index in sectionWikitext pointing to right
     * after the second signature appearing in sectionWikitext.
     *
     * Returns -1 if we couldn't find anything.
     */
    function sigIdxToStrIdx( sectionWikitext, sigIdx ) {
        console.log( "In sigIdxToStrIdx, sigIdx = " + sigIdx );
        //var SIG_REGEX_ALT = /(?:\[\[\s*(?:[Uu]ser|Special:Contributions\/).*\]\].*?\d\d:\d\d,\s\d{1,2}\s\w+?\s\d\d\d\d\s\(UTC\)|class\s*=\s*"autosigned".+?\(UTC\)<\/small>)/gm;
        //console.log( "In sigIdxToStrIdx, sectionWikitext = >>>" + sectionWikitext + "<<<" );

        // There are certain regions that we skip while attaching links:
        //
        //  - Spans with the class delsort-notice
        //  - Divs with the class xfd-relist
        //  - Some others
        //
        // So, we grab the corresponding wikitext regions with regexes,
        // and store each region's start index in spanStartIndices,
        // and each region's length in spanLengths. Then, whenever
        // we find a signature with the right index, we check if it's
        // included in one of these regions before we return it.
        var spanStartIndices = [];
        var spanLengths = [];
        var DELSORT_SPAN_RE_TXT = /<small class="delsort-notice">(?:<small>.+?<\/small>|.)+?<\/small>/.source;
        var XFD_RELIST_RE_TXT = /<div class="xfd_relist"[\s\S]+?<\/div>(\s*|<!--.+?-->)*/.source;
        var SKIP_REGION_RE = new RegExp("(" + DELSORT_SPAN_RE_TXT + ")|(" + XFD_RELIST_RE_TXT + ")", "g");
        var skipRegionMatch;
        do {
            skipRegionMatch = SKIP_REGION_RE.exec( sectionWikitext );
            if( skipRegionMatch ) {
                spanStartIndices.push( skipRegionMatch.index );
                spanLengths.push( skipRegionMatch[0].length );
            }
        } while( skipRegionMatch );
        console.log(spanStartIndices,spanLengths);

        /*
         * I apologize for making you have to read this regex
         * I made a summary, though:
         *
         *  - a wikilink, without a ]] inside it
         *  - some text, without a link to userspace or user talk space
         *  - a timestamp
         *  - as an alternative to all of the above, an autosigned script
         *    and a timestamp
         *  - some comments/whitespace or some non-whitespace
         *  - finally, the end of the line
         */
        var SIG_REGEX = /(?:\[\[\s*(([Uu]ser(\s+talk)?|Special:Contributions\/)([^\]]||\](?!\]))*?)\]\]\)?([^\[]|\[(?!\[)|\[\[(?!User(\s+talk)?:))*?\d\d:\d\d,\s\d{1,2}\s\w+?\s\d\d\d\d\s\(UTC\)|class\s*=\s*"autosigned".+?\(UTC\)<\/small>)(([ \t\f]|<!--.*?-->)*(?!\S)|\S+([ \t\f]|<!--.*?-->)*)?$/gm;
        var matchIdx = 0;
        var match;
        var matchIdxEnd;
        var dstSpnIdx;

        // `this_is_true` is to avoid triggering a JS linter rule
        var this_is_true = true;
        sigMatchLoop:
        for( ; this_is_true ; matchIdx++ ) {
            match = SIG_REGEX.exec( sectionWikitext );
            if( !match ) {
                console.log("[sigIdxToStrIdx] out of matches");
                return -1;
            }
            console.log( "sig match (matchIdx = " + matchIdx + ") is >" + match[0] + "< (index = " + match.index + ")" );

            matchIdxEnd = match.index + match[0].length;

            // Validate that we're not inside a delsort span
            for( dstSpnIdx = 0; dstSpnIdx < spanStartIndices.length; dstSpnIdx++ ) {
                //console.log(spanStartIndices[dstSpnIdx],match.index,
                //    matchIdxEnd, spanStartIndices[dstSpnIdx] +
                //        spanLengths[dstSpnIdx] );
                if( ( match.index > spanStartIndices[dstSpnIdx] &&
                    ( matchIdxEnd <= spanStartIndices[dstSpnIdx] +
                        spanLengths[dstSpnIdx] ) ) ) {

                    // That wasn't really a match (as in, this match does not
                    // correspond to any sig idx in the DOM), so we can't
                    // increment matchIdx
                    matchIdx--;

                    continue sigMatchLoop;
                }
            }

            if( matchIdx === sigIdx ) {
                return match.index + match[0].length;
            }
        }
    }

    /**
     * Inserts fullReply on the next sensible line after strIdx in
     * sectionWikitext. indentLvl is the indentation level of the
     * comment we're replying to.
     *
     * This function essentially takes the indentation level and
     * position of the current comment, and looks for the first comment
     * that's indented strictly less than the current one. Then, it
     * puts the reply on the line right before that comment, and returns
     * the modified section wikitext.
     */
    function insertTextAfterIdx( sectionWikitext, strIdx, indentLvl, fullReply ) {
        //console.log( "[insertTextAfterIdx] indentLvl = " + indentLvl );

        // strIdx should point to the end of a line
        var counter = 0;
        while( ( sectionWikitext[ strIdx ] !== "\n" ) && ( counter++ <= 50 ) ) strIdx++;

        var slicedSecWikitext = sectionWikitext.slice( strIdx );
        console.log("slicedSecWikitext = >>" + slicedSecWikitext.slice(0,50) + "<<");
        slicedSecWikitext = slicedSecWikitext.replace( /^\n/, "" );
        var candidateLines = slicedSecWikitext.split( "\n" );
        //console.log( "candidateLines =", candidateLines );
        var replyLine = 0; // line number in sectionWikitext after reply
        var INDENT_RE = /^[:\*#]+/;
        if( slicedSecWikitext.trim().length > 0 ) {
            var currIndentation, currIndentationLvl, i;

            // Now, loop through all the comments replying to that
            // one and place our reply after the last one
            for( i = 0; i < candidateLines.length; i++ ) {
                if( candidateLines[i].trim() === "" ) {
                    continue;
                }

                // Detect indentation level of current line
                currIndentation = INDENT_RE.exec( candidateLines[i] );
                currIndentationLvl = currIndentation ? currIndentation[0].length : 0;
                console.log(">" + candidateLines[i] + "< => " + currIndentationLvl);

                if( currIndentationLvl <= indentLvl ) {

                    // If it's an XfD, we might have found a relist
                    // comment instead, so check for that
                    if( xfdType && /<div class="xfd_relist"/.test( candidateLines[i] ) ) {

                        // Our reply might go on the line above the xfd_relist line
                        var potentialReplyLine = i;

                        // Walk through the relist notice, line by line
                        // After this loop, i will point to the line on which
                        // the notice ends
                        var NEW_COMMENTS_RE = /Please add new comments below this line/;
                        while( !NEW_COMMENTS_RE.test( candidateLines[i] ) ) {
                            i++;
                        }

                        // Relists are treated as if they're indented at level 1
                        if( 1 <= indentLvl ) {
                            replyLine = potentialReplyLine;
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
            if( i === candidateLines.length ) {
                replyLine = i;
            }
        } else {

            // In this case, we may be replying to the last comment in a section
            replyLine = candidateLines.length;
        }

        // Walk backwards until non-empty line
        while( replyLine >= 1 && candidateLines[replyLine - 1].trim() === "" ) replyLine--;

        console.log( "replyLine = " + replyLine );

        // Splice into slicedSecWikitext
        slicedSecWikitext = candidateLines
            .slice( 0, replyLine )
            .concat( [ fullReply ], candidateLines.slice( replyLine ) )
            .join( "\n" );

        // Remove extra newlines
        if( /\n\n\n+$/.test( slicedSecWikitext ) ) {
            slicedSecWikitext = slicedSecWikitext.trim() + "\n\n";
        }

        // We may need an additional newline if the two slices don't have any
        var optionalNewline = ( !sectionWikitext.slice( 0, strIdx ).endsWith( "\n" ) &&
                    !slicedSecWikitext.startsWith( "\n" ) ) ? "\n" : "";

        // Splice into sectionWikitext
        sectionWikitext = sectionWikitext.slice( 0, strIdx ) +
            optionalNewline + slicedSecWikitext;

        return sectionWikitext;
    }

    /**
     * Using the text in #reply-dialog-field, add a reply to the
     * current page. rplyToXfdNom is true if we're replying to an XfD nom,
     * in which case we should use an asterisk instead of a colon.
     */
    function doReply( sigIdx, indentation, header, rplyToXfdNom ) {
        var wikitext;

        // Change UI to make it clear we're performing an operation
        document.getElementById( "reply-dialog-field" ).style["background-image"] =
            "url(" + window.replyLinkPendingImageUrl + ")";
        document.querySelector( "#reply-dialog-button" ).disabled = true;
        document.querySelector( "#reply-link-cancel-button" ).disabled = true;
        setStatus( "Loading..." );

        // Send request to fetch current page wikitext
        $.getJSON(
            mw.util.wikiScript( "api" ),
            {
                format: "json",
                action: "query",
                prop: "revisions",
                rvprop: "content",
                rvlimit: 1,
                titles: mw.config.get( "wgPageName" )
            }
        ).done( function ( data ) {
            try {

                // Extract wikitext from API response
                var pageId = Object.keys(data.query.pages)[0];
                wikitext = data.query.pages[pageId].revisions[0]["*"];

                // Generate reply in wikitext form
                var reply = document.getElementById( "reply-dialog-field" ).value.trim();

                // Add a signature if one isn't already there
                if( !reply.endsWith( SIGNATURE ) ) {
                    reply += " " + ( window.replyLinkSigPrefix ? window.replyLinkSigPrefix : "" ) + SIGNATURE;
                }

                var replyLines = reply.split( "\n" );
                var fullReply;
                if( rplyToXfdNom ) {
                    fullReply = indentation + "*" + replyLines.join( "{{pb}}" );
                } else {
                    fullReply = replyLines.map( function ( line ) {
                        return indentation + "* " + line;
                    } ).join( "\n" );
                }

                // Extract wikitext of just the section
                console.log( "in doReply, header =", header );
                var sectionWikitext = getSectionWikitext( wikitext, header[2], header[1] );
                var oldSectionWikitext = sectionWikitext;

                // Now, obtain the index of the end of the comment
                var strIdx = sigIdxToStrIdx( sectionWikitext, sigIdx );

                // Check for a non-negative strIdx
                if( strIdx < 0 ) {
                    throw( "Negative strIdx (signature not found in wikitext)" );
                }

                // Determine the user who wrote the comment, for
                // edit-summary purposes
                try {
                    var userRgx = /\[\[\s*[Uu]ser(?:(?:\s+|_)talk)?\s*:\s*(.+?)(?:\/.+?)?(?:#.+?)?(?:\|.+?)?\]\]/g;
                    var userMatches = sectionWikitext.slice( 0, strIdx )
                            .match( userRgx );
                    var commentingUser = userRgx.exec(
                            userMatches[userMatches.length - 1] )[1];
                } catch( e ) {
                     // No big deal, we'll just not have a user in the summary
                }

                // Actually insert our reply into the section wikitext
                sectionWikitext = insertTextAfterIdx( sectionWikitext, strIdx,
                        indentation.length, fullReply );

                // If the user preferences indicate a dry run, print what the
                // wikitext would have been post-edit and bail out
                if( window.replyLinkDryRun ) {
                    console.log( "~~~~~~ DRY RUN CONCLUDED ~~~~~~" );
                    console.log( sectionWikitext );
                    setStatus( "Check the console for the dry-run results." );
                    return;
                }

                var newWikitext = wikitext.replace( oldSectionWikitext,
                        sectionWikitext );

                // Build summary
                var postNoun = rplyToXfdNom ? xfdType + " nomination" : "comment";
                var summary = "/* " + header[1] + " */ Replying " +
                    ( commentingUser ? " to " + postNoun + " by " +
                        commentingUser + " " : "" ) +
                    "([[User:Enterprisey/reply-link|reply-link]])";

                // Send another request, this time to actually edit the
                // page
                ( new mw.Api() ).postWithToken( "csrf", {
                    action: "edit",
                    title: mw.config.get( "wgPageName" ),
                    summary: summary,
                    text: newWikitext
                } ).done ( function ( data ) {

                    // We put this function on the window object because we
                    // give the user a "reload" link, and it'll trigger the function
                    window.replyLinkReload = function () {
                        window.location.hash = header[1].replace( / /g, "_" );
                        window.location.reload( true );
                    };
                    if ( data && data.edit && data.edit.result && data.edit.result == "Success" ) {
                        var reloadHtml = window.replyLinkAutoReload ? "automatically reloading"
                            : "<a href='javascript:window.replyLinkReload()' class='reply-link-reload'>Reload</a>";
                        setStatus( "Reply saved! (" + reloadHtml + ")" );
                        if( window.replyLinkAutoReload ) {
                            window.replyLinkReload();
                        }
                    } else {
                        if( data && data.edit && data.edit.spamblacklist ) {
                            setStatus( "Error! Your post contained a link on the <a href=" +
                                "\"https://en.wikipedia.org/wiki/Wikipedia:Spam_blacklist\"" +
                                ">spam blacklist</a>. Remove the link(s) to: " +
                                data.edit.spamblacklist.split( "|" ).join( ", " ) + " to allow saving." );
                            document.querySelector( "#reply-dialog-button" ).disabled = false;
                            document.querySelector( "#reply-link-cancel-button" ).disabled = false;
                        } else {
                            setStatus( "While saving, the edit query returned an error." +
                                " Check the browser console for more information." );
                        }
                    }
                    console.log(data);
                    document.getElementById( "reply-dialog-field" ).style["background-image"] = "";
                } ).fail ( function( code, result ) {
                    setStatus( "While saving, the AJAX request failed." );
                    console.log(code);
                    console.log(result);
                } );
            } catch ( e ) {
                setStatus( "There was an error while replying!" );
                console.log( "Content request error: " + JSON.stringify( e.message ) );
                //console.log( "Content request response: " + JSON.stringify( data ) );
                throw e;
            }
        } ).fail( function () {
            setStatus( "While getting the wikitext, there was an AJAX error." );
        } );
    }

    /**
     * Adds a "(reply)" link after the provided text node, giving it
     * the provided element id. anyIndentation is true if there's any
     * indentation (i.e. indentation string is not the empty string)
     */
    function attachLinkAfterNode( node, preferredId, anyIndentation ) {

        // Choose a parent node - walk up tree until we're under a dd, li,
        // p, or div. This walk is a bit unsafe, but this function should
        // only get called in a place where the walk will succeed.
        var parent = node;
        do {
            parent = parent.parentNode;
        } while( !( /^(p|dd|li|div)$/.test( parent.tagName.toLowerCase() ) ) );

        // Determine whether we're replying to an XfD nom
        var rplyToXfdNom = false;
        if( xfdType === "AfD" || xfdType === "MfD" ) {

            // If the comment is non-indented, we are replying to a nom
            rplyToXfdNom = !anyIndentation;
        } else if( xfdType === "TfD" || xfdType === "FfD" ) {

            // If the sibling before the previous sibling of this node
            // is a h4, then this is a nom
            rplyToXfdNom = parent.previousElementSibling &&
                parent.previousElementSibling.previousElementSibling &&
                parent.previousElementSibling.previousElementSibling.nodeType === 1 &&
                parent.previousElementSibling.previousElementSibling.tagName.toLowerCase() === "h4";
        } else if( xfdType === "CfD" ) {

            // If our grandparent is a dl and our grandparent's previous
            // sibling is a h4, then this is a nom
            rplyToXfdNom = parent.parentNode.tagName.toLowerCase() === "dl" &&
                parent.parentNode.previousElementSibling.nodeType === 1 &&
                parent.parentNode.previousElementSibling.tagName.toLowerCase() === "h4";
        }

        // Choose link label: if we're replying to an XfD, customize it
        var linkLabel = "reply" + ( rplyToXfdNom ? " to " + xfdType : "" );

        // Construct new link
        var newLinkWrapper = document.createElement( "span" );
        newLinkWrapper.className = "reply-link-wrapper";
        var newLink = document.createElement( "a" );
        newLink.href = "#";
        newLink.id = preferredId;
        newLink.dataset.originalLabel = linkLabel;
        newLink.appendChild( document.createTextNode( linkLabel ) );
        newLink.addEventListener( "click", function ( evt ) {

            // Remove previous panel
            var prevPanel = document.getElementById( "reply-dialog-panel" );
            if( prevPanel ) {
                prevPanel.remove();
            }

            // Reset previous cancel links
            var cancelLinks = iterableToList( document.querySelectorAll(
                        ".reply-link-wrapper a" ) );
            cancelLinks.forEach( function ( el ) {
                if( el != newLink ) el.textContent = el.dataset.originalLabel;
            } );

            // Handle disable action
            if( newLink.textContent === linkLabel ) {

                // Disable this link
                newLink.textContent = "cancel " + linkLabel;
            } else {

                // We've already cancelled the reply
                newLink.textContent = linkLabel;
                evt.preventDefault();
                return false;
            }

            // Create panel
            var panelEl = document.createElement( "div" );
            panelEl.style = "padding: 1em; margin-left: 1.6em;" +
                " max-width: 1200px; width: 66%; margin-top: 0.5em;";
            panelEl.id = "reply-dialog-panel";
            panelEl.innerHTML = "<textarea id='reply-dialog-field' class='mw-ui-input' placeholder='Reply here!'></textarea>" +
                "<button id='reply-dialog-button' class='mw-ui-button mw-ui-progressive'>Reply</button>" +
                "<button id='reply-link-cancel-button' class='mw-ui-button mw-ui-quiet mw-ui-destructive'>Cancel</button>" +
                "&emsp;<span id='reply-dialog-status'></span>";
            parent.insertBefore( panelEl, newLinkWrapper.nextSibling );
            var replyDialogField = document.getElementById( "reply-dialog-field" );
            replyDialogField.style = "padding: 0.625em; min-height: 10em; margin-bottom: 0.75em;";
            document.getElementById( "reply-dialog-status" ).style = "display: inline-block; width: 75%";

            /* Commented out because I could never get it to work
            // Autofill with a recommendation if we're replying to a nom
            if( rplyToXfdNom ) {
                replyDialogField.value = "'''Comment'''";

                // Highlight the "Comment" part so the user can change it
                var range = document.createRange();
                range.selectNodeContents( replyDialogField );
                //range.setStart( replyDialogField, 3 ); // start of "Comment"
                //range.setEnd( replyDialogField, 10 ); // end of "Comment"
                var sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange( range );
            }*/

            // Fetch metadata about this specific comment
            var ourMetadata = metadata[this.id];

            // Link event listener
            document.getElementById( "reply-dialog-button" )
                .addEventListener( "click", function () {

                    // ourMetadata contains data in the format:
                    // [indentation, header, sigIdx]
                    doReply( ourMetadata[2], ourMetadata[0], ourMetadata[1], rplyToXfdNom );
                }.bind( this ) );

            // Link cancel button event listener
            document.getElementById( "reply-link-cancel-button" )
                .addEventListener( "click", function () {
                    newLink.textContent = linkLabel;
                    panelEl.remove();
                } );

            // Cancel default event handler
            evt.preventDefault();
            return false;
        } );
        newLinkWrapper.appendChild( document.createTextNode( " (" ) );
        newLinkWrapper.appendChild( newLink );
        newLinkWrapper.appendChild( document.createTextNode( ")" ) );

        // Insert new link into DOM
        parent.insertBefore( newLinkWrapper, node.nextSibling );
    }

    /**
     * Uses attachLinkAfterTextNode to add a reply link after every
     * timestamp on the page.
     */
    function attachLinks () {
        var mainContent = findMainContentEl();
        var contentEls = mainContent.children;

        // Loop until we get a header
        var headerIndex = 0;
        for( headerIndex = 0; headerIndex < contentEls.length; headerIndex++ ) {
            if( contentEls[ headerIndex ].tagName.toLowerCase().startsWith( "h" ) ) break;
        }

        // If we didn't find any headers at all, that's a problem and we
        // should bail
        if( headerIndex === contentEls.length ) {
            console.error( "Hit end of loop!" );
            return;
        }

        // We also should include the first header
        if( headerIndex > 0 ) {
            headerIndex--;
        }

        // Each element is a 2-element list of [level, node]
        var parseStack = iterableToList( contentEls ).slice( headerIndex );
        parseStack.reverse();
        parseStack = parseStack.map( function ( el ) { return [ "", el ]; } );

        // Main parse loop
        var node;
        var currIndentation; // A string of symbols, like ":*::"
        var newIndentSymbol;
        var stackEl; // current element from the parse stack
        var idNum = 0; // used to make id's for the links
        var linkId = ""; // will be the element id for this link
        while( parseStack.length ) {
            stackEl = parseStack.pop();
            node = stackEl[1];
            currIndentation = stackEl[0];

            // Compatibility with "Comments in Local Time"
            var isLocalCommentsSpan = node.nodeType === 1 &&
                "span" === node.tagName.toLowerCase() &&
                node.className.indexOf( "localcomments" ) >= 0;

            // Small nodes are okay, unless they're delsort notices
            var isOkSmallNode = node.nodeType === 1 &&
                "small" === node.tagName.toLowerCase() &&
                node.className.indexOf( "delsort-notice" ) < 0;

            if( ( node.nodeType === 3 ) ||
                    isOkSmallNode ||
                    isLocalCommentsSpan )  {

                // If the current node has a timestamp, attach a link to it
                // Also, no links after timestamps, because it's just like
                // having normal text afterwards, which is banned (because
                // that means someone put a timestamp in the middle of a
                // paragraph)
                if( TIMESTAMP_REGEX.test( node.textContent.trim() ) &&
                        ( !node.nextElementSibling ||
                            node.nextElementSibling.tagName.toLowerCase() !==
                            "a" ) ) {
                    linkId = "reply-link-" + idNum;
                    attachLinkAfterNode( node, linkId, !!currIndentation );
                    idNum++;

                    // Update global metadata dictionary
                    metadata[linkId] = currIndentation;
                }
            } else if( /^(p|dl|dd|ul|li|s|span|ol)$/.test( node.tagName.toLowerCase() ) ) {
                switch( node.tagName.toLowerCase() ) {
                case "dl": newIndentSymbol = ":"; break;
                case "ul": newIndentSymbol = "*"; break;
                case "ol": newIndentSymbol = "#"; break;
                default: newIndentSymbol = ""; break;
                }

                iterableToList( node.childNodes ).forEach( function ( x ) {
                    parseStack.push( [ currIndentation + newIndentSymbol, x ] );
                } );
            }
        }

        // This loop puts two entries in the metadata dictionary:
        // the header data, and the sigIdx values
        var sigIdxEls = iterableToList( mainContent.querySelectorAll(
                "h2,h3,h4,h5,h6,span.reply-link-wrapper a" ) );
        var currSigIdx = 0, j, numSigIdxEls, currHeaderEl, currHeaderData;
        var headerIdx = 0; // index of the current header
        var headerLvl = 0; // level of the current header
        for( j = 0, numSigIdxEls = sigIdxEls.length; j < numSigIdxEls; j++ ) {
            var headerTagNameMatch = /h(\d+)/
                .exec( sigIdxEls[j].tagName.toLowerCase() );
            if( headerTagNameMatch ) {
                currHeaderEl = sigIdxEls[j];

                // Test to make sure we're not in the table of contents
                if( currHeaderEl.parentNode.className === "toctitle" ) {
                    continue;
                }

                // Reset signature counter
                currSigIdx = 0;

                // Dig down one level for the header text because
                // MW buries the text in a span inside the header
                var headerName = null;
                for( var i = 0; i < currHeaderEl.childNodes.length; i++ ) {
                    if( currHeaderEl.childNodes[i].className &&
                            currHeaderEl.childNodes[i].className
                            .indexOf( "mw-headline" ) >= 0 ) {
                        headerName = currHeaderEl.childNodes[i].textContent;
                        break;
                    }
                }

                if( headerName === null ) {
                    console.error( currHeaderEl );
                    throw "Couldn't parse a header element!";
                }

                headerLvl = headerTagNameMatch[1];
                currHeaderData = [ headerLvl, headerName, headerIdx ];
                headerIdx++;
            } else {

                // Save all the metadata for this link
                currIndentation = metadata[ sigIdxEls[j].id ];
                metadata[ sigIdxEls[j].id ] = [ currIndentation,
                    currHeaderData.slice(0), currSigIdx ];
                currSigIdx++;
            }
        }
    }

    function onReady () {

        // Exit if history page or edit page
        if( mw.config.get( "wgAction" ) === "history" ) return;
        if( document.getElementById( "editform" ) ) return;

        // Initialize the xfdType global variable, which must happen
        // before the call to attachLinks
        var pageName = mw.config.get( "wgPageName" );
        xfdType = "";
        if( mw.config.get( "wgNamespaceNumber" ) === 4) {
            if( pageName.startsWith( "Wikipedia:Articles_for_deletion/" ) ) {
                xfdType = "AfD";
            } else if( pageName.startsWith( "Wikipedia:Miscellany_for_deletion/" ) ) {
                xfdType = "MfD";
            } else if( pageName.startsWith( "Wikipedia:Templates_for_discussion/Log/" ) ) {
                xfdType = "TfD";
            } else if( pageName.startsWith( "Wikipedia:Categories_for_discussion/Log/" ) ) {
                xfdType = "CfD";
            } else if( pageName.startsWith( "Wikipedia:Files_for_discussion/" ) ) {
                xfdType = "FfD";
            }
        }

        // Insert "reply" links into DOM
        attachLinks();

        // This large string creats the "pending" texture
        window.replyLinkPendingImageUrl = "data:image/gif;base64,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";
    }

    var currNamespace = mw.config.get( "wgNamespaceNumber" );
    if ( currNamespace % 2 === 1 || currNamespace === 4 ) {
        mw.loader.load( "mediawiki.ui.input", "text/css" );
        mw.loader.using( [ "mediawiki.util", "mediawiki.api" ] ).then( function () {
            mw.hook( "wikipage.content" ).add( onReady );
        } );
    }

    // Return functions for testing
    return {
        "iterableToList": iterableToList,
        "sigIdxToStrIdx": sigIdxToStrIdx,
        "insertTextAfterIdx": insertTextAfterIdx,
        "wikitextToTextContent": wikitextToTextContent
    };
}

// Export functions for testing
if( typeof module === typeof {} ) {
    module.exports = { "loadReplyLink": loadReplyLink };
}

// If we're in the right environment, load the script
if( ( typeof jQuery !== "undefined" ) &&
        ( typeof mediaWiki !== "undefined" ) ) {
    loadReplyLink( jQuery, mediaWiki );
}
//</nowiki>
