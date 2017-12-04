//<nowiki>
( function ( $, mw ) {
    var TIMESTAMP_REGEX = /\(UTC\)$/m;
    var SIGNATURE = "~~" + "~~"; // split up because it might get processed

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
     * Escapes someString for use in a regex.
     * From https://stackoverflow.com/a/3561711/1757964.
     */
    function escapeForRegex( someString ) {
        return someString.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    }

    /**
     * Given some wikitext that's split into sections, return the full
     * wikitext (including header and newlines until the next header)
     * of the section with the given (zero-based) index.
     */
    function getSectionWikitext( wikitext, sectionIdx ) {
        var HEADER_RE = /==(=*)\s*(.+?)\s*\1==/g;
        var headerCounter = 0;
        var headerMatch;

        var startIdx = -1; // wikitext index of section start
        var endIdx = -1; // wikitext index of section end

        do {
            headerMatch = HEADER_RE.exec( wikitext );
            if( headerMatch ) {
                if( headerCounter === sectionIdx ) {
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
            endIdx = wikitext.length;
        }

        return wikitext.slice( startIdx, endIdx );
    }

    /**
     * Converts a signature index to a string index into the given
     * section wikitext. For example, if sigIdx is 1, then this function
     * will return the index in sectionWikitext corresponding to right
     * after the second signature appearing in sectionWikitext.
     *
     * Returns -1 if we couldn't find anything.
     */
    function sigIdxtoStrIdx( sectionWikitext, sigIdx ) {
         var SIG_REGEX = /\[\[\s*(?:[Uu]ser|Special:Contributions\/).*\]\].*?\d\d:\d\d,\s\d{1,2}\s\w+?\s\d\d\d\d\s\(UTC\)|class\s*=\s*"autosigned".+?\(UTC\)<\/small>/g;
         var matchIdx = 0;
         var match;
         while( true ) {
              match = SIG_REGEX.exec( sectionWikitext );
              if( !match ) return -1;
              if( matchIdx === sigIdx ) return match.index + match[0].length;
              matchIdx++;
         }
    }

    /**
     * Using the text in #reply-dialog-field, add a reply to the
     * current page.
     */
    function doReply( sigIdx, indentation, header ) {
        var wikitext;

        // Change UI to make it clear we're performing an operation
        document.getElementById( "reply-dialog-field" ).className +=
                " reply-dialog-pending";
        document.querySelector( "#reply-dialog-button" ).disabled = true;
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
                    reply += " " + SIGNATURE;
                }

                var fullReply = reply.split( "\n" ).map( function ( line ) {
                    return indentation + ":" + line;
                } ).join( "\n" );

                // Extract wikitext of just the section
                var sectionWikitext = getSectionWikitext( wikitext, header[2] );
                var oldSectionWikitext = sectionWikitext;

                // Now, obtain the index of the end of the comment
                var strIdx = sigIdxtoStrIdx( sectionWikitext, sigIdx );

                if( strIdx < 0 ) {
                    throw { name: "OopsException",
                        message: "Couldn't find the comment you're replying to!" };
                }

                //console.log(sectionWikitext.substring( strIdx - 10, 20 ) );
                //console.log(sectionWikitext.slice(0,strIdx) + "&" + sectionWikitext.slice(strIdx));

                // Determine the user who wrote the comment, for
                // edit-summary purposes
                try {
                    var userRgx = /\[\[\s*[Uu]ser(?:\s+talk)?\s*:\s*(.+?)(?:#.+)?(?:\|.+?)\]\]/g;
                    var userMatches = sectionWikitext.slice( 0, strIdx )
                            .match( userRgx );
                    var commentingUser = userRgx.exec(
                            userMatches[userMatches.length - 1] )[1];
                } catch( e ) {
                     // No big deal, we'll just not have a user in the summary
                }

                // Now, loop through all the comments replying to that
                // one and place our reply after the last one
                var slicedSecWikitext = sectionWikitext.slice( strIdx );
                slicedSecWikitext = slicedSecWikitext.replace( /^\n/, "" );
                var candidateLines = slicedSecWikitext.split( "\n" );
                var replyLine = -2; // line number in sectionWikitext before reply
                if( slicedSecWikitext.trim().length > 0 ) {

                    // Store the indentation level of the comment we're
                    // replying to
                    var prevIndentLevel = indentation.length;
                    var currIndentation, currIndentationLvl;
                    for( var i = 0; i < candidateLines.length; i++ ) {
                        if( candidateLines[i].trim() === "" ) { console.log("hark a skip");continue; }

                        // Detect indentation level of current line
                        currIndentation = /^[:\*]+/.exec( candidateLines[i] );
                        currIndentationLvl = currIndentation ? currIndentation[0].length : 0;
                        //console.log(">" + candidateLines[i] + "< => " + currIndentationLvl);

                        if( currIndentationLvl <= prevIndentLevel ) {
                            //console.log("i is " + i );
                            var onlyBlanksSoFar = candidateLines.slice( 0, i )
                                .every( function ( line ) { return line.trim() === ""; } );
                            if( i === 0 || onlyBlanksSoFar ) replyLine = -1;
                            break;
                        } else {
                            replyLine = i;
                        }
                    }

                    if( replyLine < -1 ) {
                        replyLine = candidateLines.length - 1;
                    }

                    if( replyLine >= 0 ) {
                        while( candidateLines[replyLine].trim() === "" ) replyLine--;
                    }
                } else {

                    // In this case, we may be replying to the last comment in a section
                    replyLine = -1;
                }

                //if(replyLine>=0)console.log("("+replyLine+") >>" + candidateLines[replyLine] + "<<");

                // Splice into slicedSecWikitext
                slicedSecWikitext = candidateLines
                    .slice( 0, replyLine + 1 )
                    .concat( [ fullReply ], candidateLines.slice( replyLine + 1 ) )
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

                //console.log(sectionWikitext);
                //return;

                var newWikitext = wikitext.replace( oldSectionWikitext,
                        sectionWikitext );

                // Build summary
                var summary = "/* " + header[1] + " */ Replying " +
                    ( commentingUser ? " to comment by " + commentingUser + " " : "" ) +
                    "([[User:Enterprisey/reply-link|reply-link]])";

                // Send another request, this time to actually edit the
                // page
                ( new mw.Api() ).postWithToken( "csrf", {
                    action: "edit",
                    title: mw.config.get( "wgPageName" ),
                    summary: summary,
                    text: newWikitext
                } ).done ( function ( data ) {
                    window.replyLinkReload = function () {
                        window.location.hash = header[1].replace( / /g, "_" );
                        window.location.reload( true );
                    }
                    if ( data && data.edit && data.edit.result && data.edit.result == "Success" ) {
                        var reloadHtml = window.replyLinkAutoReload ? "automatically reloading"
                            : "<a href='javascript:window.replyLinkReload()' class='reply-link-reload'>Reload</a>";
                        setStatus( "Reply saved! (" + reloadHtml + ")" );
                    } else {
                        setStatus( "While saving, the edit query returned an error. =(" );
                    }
                    console.log(data);
                    document.getElementById( "reply-dialog-field" ).className.replace( " reply-dialog-pending", "" );
                    if( window.replyLinkAutoReload ) {
                        window.replyLinkReload();
                    }
                } ).fail ( function( code, result ) {
                    setStatus( "While saving, the AJAX request failed." );
                    console.log(code);
                    console.log(result);
                } );
            } catch ( e ) {
                setStatus( "There was an error while replying!" );
                console.log( "Content request error: " + e.message );
                //console.log( "Content request response: " + JSON.stringify( data ) );
                throw e;
            }
        } ).fail( function () {
            setStatus( "While getting the wikitext, there was an AJAX error." );
        } );
    }

    /**
     * Adds a "(reply)" link after the provided text node.
     *
     * Arguments:
     *  - indentation is the string of characters that were used to
     *    indent the comment we're replying to.
     *  - header is the 3-element list [level, text, number], where
     *    level is the number giving the level of the header (h2 ->
     *    level 2),
     *  - text is the text content of the header
     *  - index is the index of this link out of all the reply links in
     *    the section.
     */
    function attachLinkAfterNode( node, indentation, header, index ) {

        // Construct new link
        var newLinkWrapper = document.createElement( "span" );
        newLinkWrapper.className = "reply-link-wrapper";
        var newLink = document.createElement( "a" );
        newLink.href = "#";
        newLink.appendChild( document.createTextNode( "reply" ) );
        newLink.dataset.index = index;
        newLink.addEventListener( "click", function ( evt ) {

            // Remove previous panel
            var prevPanel = document.getElementById( "reply-dialog-panel" );
            if( prevPanel ) {
                prevPanel.remove();
            }

            // Reset previous cancel links
            iterableToList( document.querySelectorAll(
                        ".reply-link-wrapper a" ) ).forEach( function ( el ) {
                if( el != newLink ) el.textContent = "reply";
            } );

            // Handle disable action
            if( newLink.textContent === "reply" ) {

                // Disable this link
                newLink.textContent = "cancel reply";
            } else {

                // We've already cancelled the reply
                newLink.textContent = "reply";
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
                "&emsp;<span id='reply-dialog-status'></span>";
            node.parentNode.insertBefore( panelEl, newLinkWrapper.nextSibling );
            document.getElementById( "reply-dialog-field" ).style = "padding: 0.625em; min-height: 10em; margin-bottom: 0.75em;";

            // Button event listener
            var sigIdx = parseInt( this.dataset.index );
            document.getElementById( "reply-dialog-button" )
                .addEventListener( "click", function () {
                    doReply( sigIdx, indentation, header );
                }.bind( this ) );

            // Cancel default event handler
            evt.preventDefault();
            return false;
        } );
        newLinkWrapper.appendChild( document.createTextNode( " (" ) );
        newLinkWrapper.appendChild( newLink );
        newLinkWrapper.appendChild( document.createTextNode( ")" ) );

        // Insert new link into DOM
        var parent = node.parentNode;
        parent.insertBefore( newLinkWrapper, node.nextSibling );
    }

    /**
     * Uses attachLinkAfterTextNode to add a reply link after every
     * timestamp on the page.
     */
    function attachLinks () {
        var mainContent = document.querySelector( "#mw-content-text .mw-parser-output" );
        var contentEls = mainContent.children;

        // Loop until we get a header
        var headerIndex = 0;
        for( headerIndex = 0; headerIndex < contentEls.length; headerIndex++ ) {
            if( contentEls[ headerIndex ].tagName.toLowerCase().startsWith( "h" ) ) break;
        }

        // If we didn't find any headers at all, that's a problem and we
        // should bail
        if( headerIndex === contentEls.length ) {
            console.log( "Hit end of loop!" );
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
        var currHeader; // A 3-element list of [level, text, number]
        var currIndentation; // A string of symbols, like ":*::"
        var newIndentSymbol;
        var stackEl; // current element from the parse stack
        var headerNum = 0; // zero-based index of this header
        while( parseStack.length ) {
            stackEl = parseStack.pop();
            node = stackEl[1];
            currIndentation = stackEl[0];

            if( ( node.nodeType === 3 ) ||
                    ( "small" === node.tagName.toLowerCase() ) )  {

                // If the current node has a timestamp, attach a link to it
                if( TIMESTAMP_REGEX.test( node.textContent ) ) {
                    attachLinkAfterNode( node, currIndentation, currHeader );
                }
            } else if( /p|dl|dd|ul|li/.test( node.tagName.toLowerCase() ) ) {
                switch( node.tagName.toLowerCase() ) {
                case "dl": newIndentSymbol = ":"; break;
                case "ul": newIndentSymbol = "*"; break;
                default: newIndentSymbol = ""; break;
                }

                iterableToList( node.childNodes ).forEach( function ( x ) {
                    parseStack.push( [ currIndentation + newIndentSymbol, x ] );
                } );
            } else {
                var headerMatch = /h(\d+)/.exec( node.tagName.toLowerCase() );
                if( headerMatch ) {

                    // Dig down one level for the header text because
                    // MW buries the text in a span inside the header
                    var headerText = "";
                    for( var i = 0; i < node.childNodes.length; i++ ) {
                        if( node.childNodes[i].className.indexOf( "mw-headline" ) >= 0 ) {
                            headerText = node.childNodes[i].textContent;
                            break;
                        }
                    }
                    currHeader = [ headerMatch[1], headerText, headerNum++ ];
                }
            }
        }

        // Now, insert proper sig indexes for the links
        var sigIdxEls = iterableToList( document.querySelectorAll(
                "h2,h3,h4,h5,h6,span.reply-link-wrapper a" ) );
        var currSigIdx = 0;
        for( var i = 0; i < sigIdxEls.length; i++ ) {
             if( sigIdxEls[i].tagName.toLowerCase().startsWith( "h" ) ) {
                  currSigIdx = 0;
             } else {
                  sigIdxEls[i].dataset.index = currSigIdx;
                  currSigIdx++;
             }
        }
    }

    function onReady () {

        // Exit if history page or edit page
        if( mw.config.get( "wgAction" ) === "history" ) return;
        if( document.getElementById( "editform" ) ) return;

        // Insert "reply" links into DOM
        attachLinks();

        // Load CSS
        document.querySelector("head").innerHTML += "<style>.reply-dialog-pending {" +
            "background-image: url(data:image/gif;base64,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)";
    }

    var currNamespace = mw.config.get( "wgNamespaceNumber" );
    if ( currNamespace % 2 === 1 || currNamespace === 4 ) {
        mw.loader.load( "mediawiki.ui.input", "text/css" );
        mw.loader.using( [ "mediawiki.util", "mediawiki.api.edit" ] ).then( function () {
            mw.hook( "wikipage.content" ).add( onReady );
        } );
    }
}( jQuery, mediaWiki ) );
//</nowiki>
