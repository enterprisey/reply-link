//<nowiki>
( function ( $, mw ) {
    var TIMESTAMP_REGEX = /\(UTC\)$/m;
    var PARSOID_ENDPOINT = "https://en.wikipedia.org/api/rest_v1/transform/html/to/wikitext";

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
     * Given a text node at the end of a comment, return a Deferred that
     * resolves with a regular expression string (not an object) that
     * can be used to match the wikitext of the comment.
     *
     * Why? Because the script's way of responding to a comment is to
     * find its index in the wikitext, then splice our response in at
     * that point. It's essential that our regex be as precise as
     * possible to avoid responding to the wrong comment.
     */
    function getCmtWikitextRegex( finalTextNode ) {

        // Loop through siblings and accumulate HTML
        var siblings = iterableToList( finalTextNode.parentNode.childNodes );
        siblings = siblings.slice( 0, siblings.indexOf( finalTextNode ) + 1 );
        var html = siblings.reduce( function ( acc, node ) {
            return acc + ( ( node.nodeType === 3 ) ? node.textContent : node.outerHTML );
        }, "" );

        // Deal with generic parsing mistakes: self-links and redlinks
        // Each element in mistakes: a list of [name, regex,
        // replacement] where name is a name for the mistake, regex is a
        // regex that matches the HTML, and replacement is a function
        // that takes the match object and returns some wikitext
        //
        // Our strategy: replace each mistake in the HTML with a unique
        // key, send the HTML through Parsoid, and do the reverse
        // replacement before we return the wikitext.
        var mistakes = [
            [
                "SELFLINK", /<a class="mw-selflink selflink">(.+)<\/a>/g,
                function ( match ) {
                    return "\\[\\[" +
                        mw.config.get( "wgPageName" ).replace( /_/g, " " ) +
                        "\\s*\\|\\s*" + match[1] + "\\]\\]";
                }
            ], [
                "REDLINK",
                /<a href="(?:.+?)" class="new" title="(.+?) \(page does not exist\)">(.+?)<\/a>/g,
                function ( match ) {
                    if( match[2].replace( /\s*:\s*/, ":" ) === match[1] ) {
                        return "\\[\\[" + match[2] + "\\]\\]";
                    } else {
                        return "\\[\\[" + match[1] + "\\s*\\|\\s*" + match[2] +
                        "\\]\\]";
                    }
                }
            ]
        ];

        var newHtml = html;
        var match;
        var key;
        var selfLinkWikitextReplacements = {};
        for( var i = 0; i < mistakes.length; i++ ) {
            var name = mistakes[i][0],
                regex = mistakes[i][1],
                replacement = mistakes[i][2];
            match = null;
            do {
                match = regex.exec( html );
                if( match ) {
                    key = "%!%!%" + name + "_" +
                        Object.keys( selfLinkWikitextReplacements ).length +
                        "%!%!%";
                    newHtml = newHtml.replace( match[0], key );
                    selfLinkWikitextReplacements[ key ] = replacement( match );
                }
            } while( match );
        }

        // Use Parsoid to convert HTML to wikitext
        var formData = new FormData();
        formData.append( "html", newHtml );

        // Set up the POST request
        var xhr = new XMLHttpRequest();
        xhr.open( "POST", PARSOID_ENDPOINT );

        // The POST request is async, so this function must be as well
        return new Promise( function ( resolve ) {
            xhr.addEventListener( "load", function () {
                var wikitext = xhr.responseText;
                var finalRegex = escapeForRegex( wikitext );

                // Do wikitext replacements
                for( var key in selfLinkWikitextReplacements ) {
                    finalRegex = finalRegex.replace( key, selfLinkWikitextReplacements[ key ] );
                }
                console.log(finalRegex);

                // Other places to broaden/fix the regex include...

                // ...possible whitespace around the namespace
                LINK_RE = /\\\[\\\[(.+?\:.+?)(?:\\\|.+?)?\\\]\\\]/g;
                finalRegex = finalRegex.replace( LINK_RE,
                        function ( string_match ) {
                            console.log(string_match);
                            LINK_RE.lastIndex = 0;
                            var match = LINK_RE.exec( string_match );
                            console.log(match);
                            return match[0].replace( match[1],
                                    match[1].replace( ":", "\\s*:\\s*" ) );
                        } );

                // ...abbreviations
                ABBR = /<abbr.+?<\\\/abbr>/;
                finalRegex = finalRegex.replace( ABBR,
                        function ( stringMatch ) {
                            return "(" + stringMatch + "|\\{\\{.+?\\}\\})";
                        } );

                // ...the small tag
                SMALL = /<small>.+?<\\\/small>/;
                finalRegex = finalRegex.replace( SMALL,
                        function ( stringMatch ) {
                            var innerText = stringMatch.replace("<small>", "")
                                .replace("<\\/small>", "");
                            return "(" + stringMatch +
                                "|\\{\\{\\s*small\\s*\\|\\s*" + innerText +
                                "\\s*\\}\\})";
                        } );


                resolve( finalRegex );
            } );
            xhr.send( formData );
        } );
    }

    /**
     * Using the text in #reply-dialog-field, add a reply to the
     * current page.
     */
    function doReply( contextRegex, indentation, header ) {
        var wikitext;

        // Change UI to make it clear we're performing an operation
        document.getElementById( "reply-dialog-field" ).className += " reply-dialog-pending";
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
                var reply = document.getElementById( "reply-dialog-field" ).value;
                var fullReply = indentation + ":" + reply + " ~~~~";

                // Extract wikitext of just the section
                var HEADER_RE = /==(=*)\s*(.+?)\s*\1==/g;
                var headerCounter = 0;
                var headerMatch;
                var targetHeaderIdx = header[2];

                // idxRange = [start, end], where the section starts at
                // index start and ends right before index end.
                var idxRange = [-1, -1];

                do {
                    headerMatch = HEADER_RE.exec( wikitext );
                    if( headerMatch ) {
                        if( headerCounter === targetHeaderIdx ) {
                            idxRange[0] = headerMatch.index;
                        } else if( headerCounter - 1 === targetHeaderIdx ) {
                            idxRange[1] = headerMatch.index;
                            break;
                        }
                    }
                    headerCounter++;
                } while( headerMatch );
                if( idxRange[1] < 0 ) idxRange[1] = wikitext.length;

                var sectionWikitext = wikitext.slice( idxRange[0],
                        idxRange[1] );
                var oldSectionWikitext = sectionWikitext;

                // Because the HTML sometimes has tricky whitespace
                // character entities, strip them all out and put them
                // in a dictionary to be readded
                var entityIdxList = [];
                var entityIdx;
                while( true ) {
                    entityIdx = sectionWikitext.lastIndexOf( "&nbsp;" );
                    if( entityIdx < 0 ) break;

                    entityIdxList.push( entityIdx );
                    sectionWikitext = sectionWikitext.slice( 0, entityIdx ) +
                        " " +
                        sectionWikitext.slice( entityIdx + "&nbsp;".length );
                }

                console.log(sectionWikitext);
                console.log(contextRegex);

                //var fakeContextRegex = contextRegex.replace( new RegExp( "\\\\", "g" ), "" ).replace( /s\*/g, "" );

                // Replace non-breaking spaces (the rendered version)
                // with regular spaces
                contextRegex = contextRegex.replace( /[\s\u00A0]/g, function ( m ) {
                    if( m.charCodeAt( 0 ) === 160 ) {
                        return " ";
                    } else {
                        return m;
                    }
                } );
                var ctxMatch = ( new RegExp( contextRegex, "g" ) ).exec( sectionWikitext );
                //console.log(sectionWikitext.indexOf(fakeContextRegex));
                //console.log(indexOf(sectionWikitext,fakeContextRegex));
                console.log(ctxMatch);

                // Splice fullReply into sectionWikitext
                var ctxIndex = ctxMatch.index + ctxMatch[0].length;
                var firstHalf = sectionWikitext.slice( 0, ctxIndex );
                if( !firstHalf.endsWith( "\n" ) ) {
                    fullReply = "\n" + fullReply;
                }
                //console.log("A--");
                //console.log(firstHalf);
                //console.log("B--");
                //console.log(fullReply);
                //console.log("C--");
                //console.log(sectionWikitext.slice(ctxIndex));
                //console.log("D--");

                sectionWikitext = firstHalf + fullReply + sectionWikitext.slice( ctxIndex );

                // Correct indices of nbsp entities after reply
                // insertion point
                entityIdxList = entityIdxList.map( function ( idx ) {
                    return ( idx >= ctxIndex ) ? idx + fullReply.length : idx;
                } );

                // Put entities back
                entityIdxList.reverse();
                for( var i = 0; i < entityIdxList.length; i++ ) {
                    sectionWikitext = sectionWikitext.slice( 0, entityIdxList[i] ) +
                        "&nbsp;" + sectionWikitext.slice( entityIdxList[i] + 1 );
                }

                var newWikitext = wikitext.replace( oldSectionWikitext,
                        sectionWikitext );

                // Build summary
                var summary = "/* " + header[1] + " */ Replying ([[User:Enterprisey/reply-link|reply-link]])";

                // Send another request, this time to actually edit the
                // page
                $.ajax( {
                    url: mw.util.wikiScript( "api" ),
                    type: "POST",
                    dataType: "json",
                    data: {
                        format: "json",
                        action: "edit",
                        title: mw.config.get( "wgPageName" ),
                        summary: summary,
                        token: mw.user.tokens.get( "editToken" ),
                        text: newWikitext
                    }
                } ).done ( function ( data ) {
                    if ( data && data.edit && data.edit.result && data.edit.result == "Success" ) {
                        setStatus( "Reply saved! (<a href='javascript:window.location.reload(true)' class='reload'>Reload</a>)" );
                    } else {
                        setStatus( "While saving, the edit query returned an error. =(" );
                    }
                    document.getElementById( "reply-dialog-field" ).className.replace( " reply-dialog-pending", "" );
                } ).fail ( function() {
                    setStatus( "While saving, the AJAX request failed." );
                } );
            } catch ( e ) {
                setStatus( "While getting the wikitext, there was an error." );
                console.log( "Content request error: " + e.message );
                //console.log( "Content request response: " + JSON.stringify( data ) );
            }
        } ).fail( function () {
            setStatus( "While getting the wikitext, there was an AJAX error." );
        } );
    }

    /**
     * Adds a "(reply)" link after the provided text node.
     */
    function attachLinkAfterTextNode( node, indentation, header ) {

        // Verify that this text node ends with a timestamp
        if( !TIMESTAMP_REGEX.test( node.textContent ) ) return;

        // Construct new link
        var newLinkWrapper = document.createElement( "span" );
        newLinkWrapper.className = "reply-dialog-wrapper";
        var newLink = document.createElement( "a" );
        newLink.href = "#";
        newLink.appendChild( document.createTextNode( "reply" ) );
        newLink.addEventListener( "click", function ( evt ) {

            // Remove previous panel
            var prevPanel = document.getElementById( "reply-dialog-panel" );
            if( prevPanel ) {
                prevPanel.remove();
            }

            // Disable this link
            newLink.textContent = "replying";

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

            // Button event listener (we have to get context first)
            getCmtWikitextRegex( node ).then( function ( regex ) {
                document.getElementById( "reply-dialog-button" )
                    .addEventListener( "click", function () {
                        doReply( regex, indentation, header );
                    }.bind( this ) );
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
            if( contentEls[ headerIndex ].tagName.toLowerCase() === "h2" ) break;
        }

        // If we didn't find any headers at all, that's a problem and we
        // should bail
        if( headerIndex === contentEls.length ) {
            console.log( "Hit end of loop!" );
            return;
        }

        // Each element is a 2-element list of [level, node]
        var parseStack = iterableToList( contentEls ).slice( headerIndex - 1 );
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

            if( node.nodeType === 3 ) {

                // If the current node is a text node, attempt to attach a link
                attachLinkAfterTextNode( node, currIndentation, currHeader );
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
    }

    function onReady () {
        attachLinks();

        // Load CSS
        document.querySelector("head").innerHTML += "<style>.reply-dialog-pending {" +
            "background-image: url(data:image/gif;base64,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)";
    }

    var currNamespace = mw.config.get( "wgNamespaceNumber" );
    if ( currNamespace % 2 === 1 || currNamespace === 4 ) {
        mw.loader.load( "mediawiki.ui.input", "text/css" );
        mw.loader.using( "mediawiki.util" ).then( function () {
            $( document ).ready( onReady );
        } );
    }
}( jQuery, mediaWiki ) );
//</nowiki>
