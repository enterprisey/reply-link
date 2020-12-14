// vim: ts=4 sw=4 et
//<nowiki>
function loadReplyLink( $, mw, isOnSectionWatchlistPage ) {
    var TIMESTAMP_REGEX = /\(UTC(?:(?:−|\+)\d+?(?:\.\d+)?)?\)\S*?\s*$/m;
    var EDIT_REQ_REGEX = /^((Semi|Template|Extended-confirmed)-p|P)rotected edit request on \d\d? \w+ \d{4}/;
    var EDIT_REQ_TPL_REGEX = /\{\{edit (template|fully|extended|semi)-protected\s*(\|.+?)*\}\}/;
    var LITERAL_SIGNATURE = "~~" + "~~"; // split up because it might get processed
    var i18n = {
        "en": {
            "rl-advert": " (using [[w:en:User:Enterprisey/reply-link|reply-link]])",
            "rl-error-status": "There was an error while replying! Please leave a note at " +
                "<a href='https://en.wikipedia.org/wiki/User_talk:Enterprisey/reply-link'>the script's talk page</a>" +
                " with any errors in <a href='https://en.wikipedia.org/wiki/WP:JSERROR'>the browser console</a>, if possible.",
            "rl-replying-to": "Replying to ",
            "rl-reloading": "automatically reloading",
            "rl-reload": "Reload",
            "rl-saved": "Reply saved!",
            "rl-cancel": "cancel ",
            "rl-placeholder": "Reply here!",
            "rl-reply": "Reply",
            "rl-preview": "Preview",
            "rl-cancel-button": "Cancel",
            "rl-started-reply": "You've started a reply but haven't posted it",
            "rl-loading": "Loading...",
            "rl-reply-label": "reply",
            "rl-to-label": " to ",
            "rl-auto-indent": "Automatically indent?",
            "rl-out-of-date": "Someone has edited this page since you started replying!",
            "rl-edit-fail": "While replying, the edit failed."
        },
        "pt": {
            "rl-advert": "(usando [[w:en:User:Enterprisey/reply-link|reply-link]])",
            "rl-error-status": "Ocorreu um erro ao responder! Por favor deixe um comentário na " +
                "<a href='https://en.wikipedia.org/wiki/User_talk:Enterprisey/reply-link'>página de discussão do script</a>" +
                " informando os erros que apareçam <a href='https://en.wikipedia.org/wiki/WP:JSERROR'>no console do navegador</a>, se possível.",
            "rl-replying-to": "Respondendo a ",
            "rl-reloading": "recarregando automaticamente",
            "rl-reload": "Recarregar",
            "rl-saved": "Resposta publicada!",
            "rl-cancel": "cancelar ",
            "rl-placeholder": "Responda aqui!",
            "rl-reply": "Responder",
            "rl-preview": "Prever",
            "rl-cancel-button": "Cancelar",
            "rl-started-reply": "Você começou a responder, mas não publicou sua resposta",
            "rl-loading": "Carregando...",
            "rl-reply-label": "responder",
            "rl-to-label": " a ",
            "rl-auto-indent": "Indentar automaticamente?"
        }
    };
    var HEADER_SELECTOR = "h1,h2,h3,h4,h5,h6";
    var MAX_UNICODE_DECIMAL = 1114111;
    var HEADER_REGEX = /^\s*=(=*)\s*(.+?)\s*\1=\s*$/gm;
    var JUMP_COOKIE_KEY = "reply_link_jump";

    // T:TDYK, used at the end of loadReplyLink
    var TTDYK = "Template:Did_you_know_nominations";
    var RFA_PG = "Wikipedia:Requests_for_adminship/";

    // Threshold for indentation when we offer to outdent
    var OUTDENT_THRESH = 8;

    // All of the interface message keys that we explicitly load
    var INT_MSG_KEYS = [ "mycontris" ];

    // Date format regexes in signatures (i.e. the "default date format")
    var DATE_FMT_RGX = {
        "//en.wikipedia.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source,
        "//test.wikipedia.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source,
        "//simple.wikipedia.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source,
        "//en.wikisource.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source,
        "//meta.wikimedia.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source,
        "//pt.wikipedia.org": /\d\dh\d\dmin\sde \d{1,2} de \w+? de \d{4}/.source,
        "//commons.wikimedia.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source
    }

    // Shared API object
    var api;

    /*
     * Regex *sources* for a "userspace" link. Basically the
     * localized equivalent of User( talk)?|Special:Contributions/
     * Initialized in buildUserspcLinkRgx, which is called near the top
     * of the closure in handleWrapperClick.
     *
     * Three subproperties: und for underscores instead of spaces (e.g.
     * "User_talk"), spc for spaces (e.g. "User talk"), and both for
     * a regex combining the two (used for matching on wikitext).
     */
    var userspcLinkRgx = null;

    /**
     * This dictionary is some global state that holds a dictionary
     * for each "(reply)" link (keyed by their unique IDs):
     *
     *  - indentation, the indentation string for the comment (e.g. ":*::")
     *  - sigIdx, the zero-based index of the signature from the top
     *    of the section
     *
     * This dictionary is populated in attachLinks, and unpacked in the
     * click handler for the links (defined in attachLinkAfterNode); the
     * values are then passed to doReply.
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
     * The current page name, including namespace, because we may be reading it
     * a lot (especially in findUsernameInElem if we're on someone's user
     * talk page). Has underscores instead of spaces!
     */
    var currentPageName;

    /**
     * A map for signatures that contain redirects, so that they can still
     * pass the sanity check. This will be updated manually, because I
     * don't want the overhead of a whole 'nother API call in the middle
     * of the reply process. If this map grows too much, though, I'll
     * consider switching to either a toolforge-hosted API or the
     * Wikipedia API. Used in doReply, for the username sanity check.
     */
    var sigRedirectMapping = {
        "Salvidrim": "Salvidrim!"
    };

    /**
     * When the reply is saved via API, this flag is set to true to
     * disable the onbeforeunload handler.
     */
    var replyWasSaved = false;

    /**
     * Cache for getWikitext.
     */
    var getWikitextCache = {};

    // Polyfill from https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/includes
    if( !String.prototype.includes ) {
        String.prototype.includes = function( search, start ) {
            if( search instanceof RegExp ) {
                throw TypeError('first argument must not be a RegExp');
            }
            if( start === undefined ) {
                start = 0;
            }
            return this.indexOf( search, start ) !== -1;
        };
    }

    /**
     * Get the formatted namespace name for a namespace ID.
     * Quick ref: user = 2, proj = 4
     */
    function fmtNs( nsId ) {
        return mw.config.get( "wgFormattedNamespaces" )[ nsId ];
    }

    /**
     * Escapes a string for inclusion in a regex.
     */
    function escapeForRegex( s ) {
        return s.replace( /[-\/\\^$*+?.()|[\]{}]/g, '\\$&' );
    }

    /*
     * MediaWiki turns spaces before certain punctuation marks
     * into non-breaking spaces, so fix those. This is done by
     * the armorFrenchSpaces function in Mediawiki, in the file
     * /includes/parser/Sanitizer.php
     */
    function deArmorFrenchSpaces( text ) {
        return text.replace( /\xA0([?:;!%»›])/g, " $1" )
            .replace( /([«‹])\xA0/g, "$1 " );
    }

    /**
     * Remove duplicates from an array.
     * https://stackoverflow.com/a/9229821/1757964
     */
    function removeDuplicates( array ) {
        var seen = {};
        return array.filter( function( item ) {
            return seen.hasOwnProperty( item ) ? false : ( seen[ item ] = true );
        } );
    }

    /**
     * Capitalize the first letter of a string.
     */
    function capFirstLetter( someString ) {
        return someString.charAt( 0 ).toUpperCase() + someString.slice( 1 );
    }

    /**
     * Namespace name to ID.
     * For example, nsNameToId( "Template" ) === 10.
     */
    function nsNameToId( nsName ) {
        return mw.config.get( "wgNamespaceIds" )[ nsName.toLowerCase().replace( / /g, "_" ) ];
    }

    /**
     * Canonical-ize a namespace.
     */
    function canonicalizeNs( ns ) {
        return fmtNs( nsNameToId( ns ) );
    }

    /**
     * This function converts any (index-able) iterable into a list.
     */
    function iterableToList( nl ) {
        var len = nl.length;
        var arr = new Array( len );
        for( var i = 0; i < len; i++ ) arr[i] = nl[i];
        return arr;
    }

    /**
     * Process HTML character entities.
     * From https://stackoverflow.com/a/46851765
     */
    function processCharEntities( text ) {
        var el = document.createElement('div');
        return text.replace( /\&[#0-9a-z]+;/gi, function ( enc ) {
            el.innerHTML = enc;
            return el.innerText
        } );
    }

    /**
     * Process HTML character entities, MediaWiki style
     * From https://stackoverflow.com/a/46851765
     */
    function processCharEntitiesWikitext( text ) {
        var el = document.createElement('div');
        return text.replace( /\&[#0-9a-z]+;/gi, function ( enc ) {
            if( /#\d+/.test( enc ) ) {
                if( parseInt( enc.slice( 1 ) ) > MAX_UNICODE_DECIMAL ) {
                    return enc;
                }
            }
            el.innerHTML = enc;
            return el.innerText
        } );
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
     * Sets the panel status when an error happened. Good for use in
     * catch blocks.
     */
    function setStatusError( e ) {
        console.error(e);
        setStatus( mw.msg( "rl-error-status" ) );
        if( e.message ) {
            console.log( "Content request error: " + JSON.stringify( e.message ) );
        }
        console.log( "DEBUG INFORMATION: '"+currentPageName+"' @ " + mw.config.get( "wgCurRevisionId" ) );
        throw e;
    }

    /**
     * Given some wikitext, processes it to get just the text content.
     * This function should be identical to the MediaWiki function
     * that gets the wikitext between the equal signs and comes up
     * with the id's that anchor the headers.
     */
    function wikitextToTextContent( wikitext ) {
        return processCharEntities( wikitext )
            .replace( /\[\[:?(?:[^\|\]]+?\|)?([^\]\|]+?)\]\]/g, "$1" )
            .replace( /\{\{\s*tl\s*\|\s*(.+?)\s*\}\}/g, "{{$1}}" )
            .replace( /\{\{\s*[Uu]\s*\|\s*(.+?)\s*\}\}/g, "$1" )
            .replace( /('''?)(.+?)\1/g, "$2" )
            .replace( /<s>(.+?)<\/s>/g, "$1" )
            .replace( /<big>(.+?)<\/big>/g, "$1" )
            .replace( /<span.*?>(.*?)<\/span>/g, "$1" );
    }

    function wikitextHeaderEqualsDomHeader( wikitextHeader, domHeader ) {
        return wikitextToTextContent( wikitextHeader ) === deArmorFrenchSpaces( domHeader );
    }

    /**
     * Finds and returns the div that is the immediate parent of the
     * first talk page header on the page, so that we can read all the
     * sections by iterating through its child nodes.
     */
    function findMainContentEl() {

        // Which header are we looking for?
        var targetHeader = "h2";
        if( xfdType || currentPageName.startsWith( RFA_PG ) ) targetHeader = "h3";
        if( currentPageName.startsWith( TTDYK ) ) targetHeader = "h4";

        // The element itself will be the text span in the h2; its
        // parent will be the h2; and the parent of the h2 is the
        // content container that we want
        var candidates = document.querySelectorAll( targetHeader + " > span.mw-headline" );
        if( !candidates.length ) {
            return document.getElementById( "mw-content-text" );
        }
        var candidate = candidates[ candidates.length - 1 ].parentElement.parentElement;

        // Compatibility with User:Kephir/gadgets/unclutter.js
        if( candidate.className.includes( "kephir-unclutter-discussion-wrapper" ) ) {
            candidate = candidate.parentElement;
        }

        // Compatibility with User:Enterprisey/hover-edit-section
        // That script puts each section in its own div, so we need to
        // go out another level if it's running
        if( candidate.className === "hover-edit-section" ) {
            candidate = candidate.parentElement;
        }

        return candidate;
    }

    /**
     * Gets the wikitext of a page with the given title (namespace required).
     * Returns an object with keys "content" and "timestamp".
     */
    function getWikitext( title, useCaching ) {
        if( useCaching === undefined ) useCaching = false;
        if( useCaching && getWikitextCache[ title ] ) {
            return $.when( getWikitextCache[ title ] );
        }
        return $.getJSON(
            mw.util.wikiScript( "api" ),
            {
                format: "json",
                action: "query",
                prop: "revisions",
                rvprop: "timestamp|content|ids",
                rvslots: "main",
                rvlimit: 1,
                titles: title,
                formatversion: 2,
            }
        ).then( function ( data ) {
            if( data.query.pages[0].revisions ) {
                var rev = data.query.pages[0].revisions[0];
                var result = { revId: rev.revid, timestamp: rev.timestamp, content: rev.slots.main.content };
                getWikitextCache[ title ] = result;
                return result;
            } else {
                console.error( data );
                throw new Error( "[getWikitext] bad response: " + data );
                return {};
            }
        } );
    }

    function getLastRevId( title ) {
        return $.getJSON(
            mw.util.wikiScript( "api" ),
            {
                format: "json",
                action: "query",
                prop: "revisions",
                rvprop: "ids",
                rvslots: "main",
                rvlimit: 1,
                titles: title,
                formatversion: 2,
            }
        ).then( function ( data ) {
            return data.query.pages[0].revisions[0].revid;
        } );
    }

    function getPathToElement( givenEl ) {
        var path = [];
        var currEl = givenEl;
        while( ( currEl.id !== "mw-content-text" ) && ( currEl.tagName.toLowerCase() !== "body" ) ) {
            path.push( iterableToList( currEl.parentNode.children ).indexOf( currEl ) );
            currEl = currEl.parentNode;
        }
        return path.join( "|" );
    }

    function followPathToElement( path ) {
        path = path.split( "|" );
        var el = document.getElementById( "mw-content-text" );
        for( var i = path.length - 1; i >= 0; i-- ) {
            el = el.children[parseInt(path[i])];
        }
        return el;
    }

    function highlightContainerOf( el ) {
        outer:
        while( true ) {
            switch( el.tagName.toLowerCase() ) {
                case "ul":
                case "ol":
                case "li":
                case "dd":
                case "dl":
                case "p":
                case "div":
                case "table":
                case "td":
                    break outer;
            }
            el = el.parentNode;
        }
        el.className += "reply-link-jump-highlight";
    }

    function getTimestampGivenAuthorLink( authorLink ) {
        var currNode = authorLink;
        while( !currNode.textContent.includes( "(UTC)" ) ) {
            if( currNode.nextSibling ) {
                currNode = currNode.nextSibling;
            } else {
                currNode = currNode.parentNode;
            }
        }
        if( currNode.textContent.includes( "(UTC)" ) ) {
            var matches = currNode.textContent.match( new RegExp( DATE_FMT_RGX[mw.config.get( "wgServer" )], "g" ) );
            if( matches.length > 0 ) {
                return matches[ matches.length - 1 ];
            }
        }
        return null;
    }

    /**
     * Creates userspcLinkRgx. Called in handleWrapperClick and the test
     * runner at the bottom.
     */
    function buildUserspcLinkRgx() {
        var nsIdMap = mw.config.get( "wgNamespaceIds" );
        var nsRgxFragments = [];
        var contribsSecondFrag = ":" + escapeForRegex( mw.messages.get( "mycontris" ) ) + "\\/";
        for( var nsName in nsIdMap ) {
            if( !nsIdMap.hasOwnProperty( nsName ) ) continue;
            switch( nsIdMap[nsName] ) {
                case 2:
                case 3:
                    nsRgxFragments.push( escapeForRegex( capFirstLetter( nsName ) ) + "\\s*:" );
                    break;
                case -1:
                    nsRgxFragments.push( escapeForRegex( capFirstLetter( nsName ) ) + contribsSecondFrag );
                    break;
            }
        }
        userspcLinkRgx = {};
        userspcLinkRgx.spc = "(?:" + nsRgxFragments.join( "|" ).replace( /_/g, " " ) + ")";
        userspcLinkRgx.und = userspcLinkRgx.spc.replace( / /g, "_" );
        userspcLinkRgx.both = userspcLinkRgx.spc.replace( / /g, "(?: |_)" );
    }

    /**
     * Is there a signature (four tildes) present in the given text,
     * outside of a nowiki element?
     */
    function hasSig( text ) {

        // no literal signature?
        if( !text.includes( LITERAL_SIGNATURE ) ) return false;

        // if there's a literal signature and no nowiki elements,
        // there must be a real signature
        if( !text.includes( "<nowiki>" ) ) return true;

        // Save all nowiki spans
        var nowikiSpanStarts = []; // list of ignored span beginnings
        var nowikiSpanLengths = []; // list of ignored span lengths
        var NOWIKI_RE = /<nowiki>.*?<\/nowiki>/g;
        var spanMatch;
        do {
            spanMatch = NOWIKI_RE.exec( text );
            if( spanMatch ) {
                nowikiSpanStarts.push( spanMatch.index );
                nowikiSpanLengths.push( spanMatch[0].length );
            }
        } while( spanMatch );

        // So that we don't check every ignore span every time
        var nowikiSpanStartIdx = 0;

        var LIT_SIG_RE = new RegExp( LITERAL_SIGNATURE, "g" );
        var sigMatch;

        matchLoop:
        do {
            sigMatch = LIT_SIG_RE.exec( text );
            if( sigMatch ) {

                // Check that we're not inside a nowiki
                for( var nwIdx = nowikiSpanStartIdx; nwIdx <
                    nowikiSpanStarts.length; nwIdx++ ) {
                    if( sigMatch.index > nowikiSpanStarts[nwIdx] ) {
                        if ( sigMatch.index + sigMatch[0].length <=
                            nowikiSpanStarts[nwIdx] + nowikiSpanLengths[nwIdx] ) {

                            // Invalid sig
                            continue matchLoop;
                        } else {

                            // We'll never encounter this span again, since
                            // headers only get later and later in the wikitext
                            nowikiSpanStartIdx = nwIdx;
                        }
                    }
                }

                // We aren't inside a nowiki
                return true;
            }
        } while( sigMatch );
        return false;
    }

    /**
     * Given an Element object, attempt to recover a username from it.
     * Also will check up to two elements prior to the passed element.
     * Returns null if no username was found. Otherwise, returns an
     * object with these properties:
     *
     *  - username: The username that we found.
     *  - link: The DOM element for the link from which we got the
     *    username.
     */
    function findUsernameInElem( el ) {
        if( !el ) return null;
        var links;
        for( let i = 0; i < 3; i++ ) {
            if( el === null ) break;
            links = el.tagName.toLowerCase() === "a" ? [ el ]
                : el.querySelectorAll( "a" );
            //console.log(i,"top of outer for in findUsernameInElem ",el, " links -> ",links);

            // Compatibility with "Comments in Local Time"
            if( el.className.includes( "localcomments" ) ) i--;

            // If we couldn't get any links, try again with prev elem
            if( !links ) continue;

            var link; // his name isn't zelda
            for( var j = 0; j < links.length; j++ ) {
                link = links[j];

                //console.log(link,decodeURIComponent(link.getAttribute("href")));
                if( link.className.includes( "mw-selflink" ) ) {
                    return { username: currentPageName.replace( /.+:/, "" )
                        .replace( /_/g, " " ), link: link };
                }

                // Also matches redlinks. Why people have redlinks in their sigs on
                // purpose, I may never know.
                //console.log( "^\\/(?:wiki\\/" + userspcLinkRgx.und + /(.+?)(?:\/.+?)?(?:#.+)?|w\/index\.php\?title=User(?:_talk)?:(.+?)&action=edit&redlink=1/.source + ")$" )
                var sigLinkRe = new RegExp( "\\/(?:wiki\\/" + userspcLinkRgx.und + /(.+?)(?:\/.+?)?(?:#.+)?|w\/index\.php\?title=/.source + userspcLinkRgx.und + /(.+?)&action=edit&redlink=1/.source + ")$" );
                var liveDecodedHref = decodeURIComponent( link.getAttribute( "href" ) );
                if( liveDecodedHref.startsWith( "/" ) ) {
                    liveDecodedHref = "https:" + mw.config.get( "wgServer" ) + liveDecodedHref;
                }
                var usernameMatch = sigLinkRe.exec( liveDecodedHref );
                if( usernameMatch ) {
                //console.log("usernameMatch",usernameMatch)
                    var rawUsername = usernameMatch[1] ? usernameMatch[1] : usernameMatch[2];
                    return {
                        username: decodeURIComponent( rawUsername ).replace( /_/g, " " ),
                        link: link
                    };
                }
            }

            // Go backwards one element and try again
            el = el.previousElementSibling;
        }
        return null;
    }

    /**
     * Given a reply-link-wrapper span, attempts to find who wrote
     * the comment that precedes it. For information about the return
     * value, see the documentation for findUsernameInElem.
     */
    function getCommentAuthor( wrapper ) {
        var sigNode = wrapper.previousSibling;
        //console.log(sigNode,sigNode.style,sigNode.style ? sigNode.style.getPropertyValue("size"):"");
        var smallOrFake = sigNode.nodeType === 1 &&
                ( sigNode.tagName.toLowerCase() === "small" ||
                ( sigNode.tagName.toLowerCase() === "span" &&
                    sigNode.style && ( sigNode.style.getPropertyValue( "font-size" ) === "85%" ||
                                       sigNode.style.getPropertyValue( "font-size" ).indexOf( "small" ) === 0 ) ) );

        var possUserLinkElem = ( smallOrFake && sigNode.children.length > 1 )
            ? sigNode.children[sigNode.children.length-1]
            : sigNode.previousElementSibling;
        return findUsernameInElem( possUserLinkElem );
    }

    /**
     * Given the wikitext of a section, attempt to find the first edit
     * request template in it, and then mark that template as answered.
     * Returns the modified section wikitext.
     */
    function markEditReqAnswered( sectionWikitext ) {
        var editReqMatch = EDIT_REQ_TPL_REGEX.exec( sectionWikitext );
        if( !editReqMatch ) {
            console.error( "Couldn't find an edit request!" );
            return sectionWikitext;
        }

        var ansParamMatch = /ans(wered)?=.*?(\||\}\})/.exec( editReqMatch[0] );
        if( !ansParamMatch ) {
            sectionWikitext = sectionWikitext.replace(
                editReqMatch[0],
                editReqMatch[0].replace( "}}", "answered=yes}}" )
            );
        } else {
            var newEditReqTpl = editReqMatch[0].replace( ansParamMatch[0],
                "answered=yes" + ansParamMatch[2] );
            sectionWikitext = sectionWikitext.replace(
                editReqMatch[0],
                newEditReqTpl
            );
        }
        return sectionWikitext;
    }

    function allContentHeaders() {
        var allHeaders = document.querySelector( "#mw-content-text" )
            .querySelectorAll( HEADER_SELECTOR );
        return iterableToList( allHeaders )
            .filter( function ( header ) {
                // The word "Contents" at the top of the table of contents is a heading
                return ( header.getAttribute( "id" ) !== "mw-toc-heading" );
            } );
    }

    /**
     * Given a header element, finds the title (full with namespace, spaces
     * instead of underscores) of the page it's from.
     */
    function pageNameOfHeader( header ) {
        var editLinks = iterableToList( header.querySelectorAll( ".mw-editsection a" ) )
            .filter( function ( e ) { return e.textContent.indexOf( "edit" ) === 0; } );
        if( editLinks.length ) {
            var encoded = editLinks[0]
                .getAttribute( "href" )
                .match( /title=(.+?)(?:$|&)/ )
                [1];
            return decodeURIComponent( encoded ).replace( /_/g, " " );
        } else {
            return null;
        }
    }

    /**
     * Given a DOM object in the current page corresponding to a link in a
     * signature, locate the section header (i.e. h1, h2, etc element) for the
     * section containing that comment.
     */
    function findSectionHeaderElement( sigLinkElem ) {
        var nearestHeader = null;
        var currElem = sigLinkElem;
        var sigLinkTopPos = sigLinkElem.getBoundingClientRect().top;

        loop:
        while( ( currElem.id !== "mw-content-text" ) && ( currElem.tagName.toLowerCase() !== "body" ) ) {
            var familiarTagName = false;
            switch( currElem.tagName.toLowerCase() ) {
                case "ul":
                case "ol":
                case "li":
                case "dd":
                case "dl":
                case "a":
                case "i":
                case "code":
                    // Headers aren't in these elements (and it would be a waste to check)
                    break;
                case "h1":
                case "h2":
                case "h3":
                case "h4":
                case "h5":
                case "h6":
                    // Well, that was convenient (found a header)
                    nearestHeader = currElem;
                    break loop;
                case "p":
                case "span": // unlikely, but we'll check anyway
                case "div":
                case "table": // yeah, sometimes people put their whole talk page in a template
                case "td":
                case "sub":
                case "sup":
                case "b":
                    familiarTagName = true;
                default:
                    var tagName = currElem.tagName.toLowerCase();
                    if( !familiarTagName ) {
                        // just in case there's a tag not listed here that needs special handling
                        console.warn( "unknown tag name ", tagName, " ", currElem );
                    }
                    var childHeaders = currElem.querySelectorAll( HEADER_SELECTOR );
                    if( childHeaders ) {
                        childHeaders = iterableToList( childHeaders )
                            .filter( function ( header ) {
                                // We don't want to pick up headers below the comment
                                return header.getBoundingClientRect().top < sigLinkTopPos;
                            } );
                        if( childHeaders.length > 0 ) {
                            nearestHeader = childHeaders[childHeaders.length - 1];
                            break loop;
                        }
                    }
                    break;
            } // end switch ( currElem.tagName )

            if( currElem.previousElementSibling ) {
                currElem = currElem.previousElementSibling;
            } else {
                currElem = currElem.parentNode;
            }
        } // end while

        if( nearestHeader === null ) {
            console.warn( "nearestHeader was null" );
        }
        return nearestHeader;
    }

    /**
     * Finds a section in the given page's wikitext.
     *
     * If givenHeaderEl is null, that means it's the "zeroth" section, i.e.
     * the section that ends at the first page header.
     */
	function findSectionInPageWikitext( givenHeaderEl, pageTitle, pageWikitext ) {
        var allHeaders = document.querySelector( "#mw-content-text" )
            .querySelectorAll( HEADER_SELECTOR );
        var allHeadersFromTarget = iterableToList( allHeaders )
            .filter( function ( header ) {
                // The word "Contents" at the top of the table of contents is a heading
                return ( header.getAttribute( "id" ) !== "mw-toc-heading" ) &&
                    pageNameOfHeader( header ) === pageTitle;
            } );

        // Find all the headers in the wikitext

        // Save all ignored spans
        var ignoredSpanStarts = []; // list of ignored span beginnings
        var ignoredSpanLengths = []; // list of ignored span lengths
        var IGNORED_RE = /(?:<(nowiki|pre|noinclude|source)>[\s\S]*?<\/\1>)|<!--[\s\S]+?-->/g;
        var spanMatch;
        do {
            spanMatch = IGNORED_RE.exec( pageWikitext );
            if( spanMatch ) {
                ignoredSpanStarts.push( spanMatch.index );
                ignoredSpanLengths.push( spanMatch[0].length );
            }
        } while( spanMatch );

        // So that we don't check every ignore span every time
        var ignoredSpanStartIdx = 0;

        var headerMatches = [];
        var headerMatch;

        matchLoop:
        do {
            headerMatch = HEADER_REGEX.exec( pageWikitext );
            if( headerMatch ) {

                // Check that we're not inside a ignored span
                for( var ignoredIdx = ignoredSpanStartIdx; ignoredIdx <
                    ignoredSpanStarts.length; ignoredIdx++ ) {
                    if( headerMatch.index > ignoredSpanStarts[ignoredIdx] ) {
                        if ( headerMatch.index + headerMatch[0].length <=
                            ignoredSpanStarts[ignoredIdx] + ignoredSpanLengths[ignoredIdx] ) {

                            // Not a header, since we're inside a ignored span
                            continue matchLoop;
                        } else {

                            // We'll never encounter this span again, since
                            // headers only get later and later in the wikitext
                            ignoredSpanStartIdx = ignoredIdx;
                        }
                    }
                }
                headerMatches.push( headerMatch );
            }
        } while( headerMatch );

        // We'll use this dictionary to calculate the duplicate index
        var headersByText = {};
        for( var i = 0; i < headerMatches.length; i++ ) {

            // Group 2 of HEADER_REGEX is the header text
            var text = headerMatches[i][2];
            headersByText[text] = ( headersByText[text] || [] ).concat( i );
        }

        // allHeadersFromTarget should contain every header we found in the wikitext
        // (and more, if sourcePageName was transcluded multiple times)
        if( allHeadersFromTarget.length % headerMatches.length !== 0 ) {
            for( var i = 0; i < Math.max( allHeadersFromTarget.length, headerMatches.length ); i++ ) {
                console.error( i, allHeadersFromTarget[i], allHeadersFromTarget[i] && allHeadersFromTarget[i].textContent, headerMatches[i] );
            }
            throw new Error( "non-divisble header list lengths" );
        }

        if( givenHeaderEl === null ) {
            var sectionEndIdx = headerMatches[0] ? headerMatches[0].index : pageWikitext.length;
            return {
                title: "",
                dupIdx: 0,
                startIdx: 0,
                endIdx: sectionEndIdx,
                idxInDomHeaders: -1,
            };
        }

        var headerIdx = allHeadersFromTarget.indexOf( givenHeaderEl );
        if( headerIdx < 0 ) {
            console.error( 'givenHeaderEl', givenHeaderEl );
            console.error( 'allHeadersFromTarget', allHeadersFromTarget );
            throw new Error( "givenHeaderEl not in allHeadersFromTarget" );
        }
        var trueHeaderIdx = headerIdx % headerMatches.length;
        var headerText = headerMatches[trueHeaderIdx][2];

        // NOTE! The duplicate index is calculated relative to the
        // *wikitext* header matches (because that's how the backend
        // does it)! That is, if we have a page that includes two
        // headers, both called "a", and we transclude that page
        // twice, the result will be four headers called "a". But we
        // want to assign those four headers, respectively, the
        // duplicate indices of 0, 1, 0, 1. That's why we use
        // trueHeaderIdx here, not headerIdx.
        var dupIdx = headersByText[headerText].indexOf( trueHeaderIdx );

        var sectionStartIdx = headerMatches[trueHeaderIdx].index;
        var sectionEndIdx = headerMatches[trueHeaderIdx + 1]
                ? headerMatches[trueHeaderIdx + 1].index
                : pageWikitext.length;

        return {
            title: headerText,
            dupIdx: dupIdx,
            startIdx: sectionStartIdx,
            endIdx: sectionEndIdx,
            idxInDomHeaders: headerIdx,
        };
    }

    /**
     * Given a DOM object in the current page corresponding to a link in a
     * signature, locate the section containing that comment. That section may
     * not be in the current page!
     */
    function findSectionMain( sigLinkElem ) {
        var nearestHeader = findSectionHeaderElement( sigLinkElem );
        var pageTitle = ( nearestHeader ? pageNameOfHeader( nearestHeader ) : currentPageName ).replace( /_/g, " " );
        return getWikitext( pageTitle, /* useCaching */ true ).then( function ( revObj ) {
            var pageText = revObj.content;
            var sectionObj = findSectionInPageWikitext( nearestHeader, pageTitle, pageText );
            sectionObj.pageTitle = pageTitle;
            sectionObj.revObj = revObj;
            sectionObj.headerEl = nearestHeader;
            //sectionObj.level = parseInt( nearestHeader.tagName.substring( 1 ) ); // that is, cut off the "h" at the beginning
            return sectionObj;
        }, function ( err ) { throw new Error( err ); } );
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
        //console.log( "In sigIdxToStrIdx, sigIdx = " + sigIdx );

        // There are certain regions that we skip while attaching links:
        //
        //  - Spans with the class delsort-notice
        //  - Divs with the class xfd-relist (and other divs)
        //
        // So, we grab the corresponding wikitext regions with regexes,
        // and store each region's start index in spanStartIndices, and
        // each region's length in spanLengths. Then, whenever we find a
        // signature with the right index, if it's included in one of
        // these regions, we skip it and move on.
        var spanStartIndices = [];
        var spanLengths = [];
        var DELSORT_SPAN_RE_TXT = /<small class="delsort-notice">(?:<small>.+?<\/small>|.)+?<\/small>/.source;
        var XFD_RELIST_RE_TXT = /<div class="xfd_relist"[\s\S]+?<\/div>(\s*|<!--.+?-->)*/.source;
        var STRUCK_RE_TXT = /<s>.+?<\/s>/.source;
        var SKIP_REGION_RE = new RegExp("(" + DELSORT_SPAN_RE_TXT + ")|(" +
            XFD_RELIST_RE_TXT + ")|(" +
            STRUCK_RE_TXT + ")", "ig");
        var skipRegionMatch;
        do {
            skipRegionMatch = SKIP_REGION_RE.exec( sectionWikitext );
            if( skipRegionMatch ) {
                spanStartIndices.push( skipRegionMatch.index );
                spanLengths.push( skipRegionMatch[0].length );
            }
        } while( skipRegionMatch );
        //console.log(spanStartIndices,spanLengths);

        var dateFmtRgx = DATE_FMT_RGX[mw.config.get( "wgServer" )];
        if( !dateFmtRgx ) {
            throw new Error( "Error! I don't know the native date format used by the server '" + mw.config.get( "wgServer" ) + "'!" );
        }
        /*
         * I apologize for making you have to read this regex.
         * I made a summary, though:
         *
         *  - a wikilink, without a ]] inside it
         *  - some text, without a link to userspace or user talk space
         *  - a timestamp
         *  - as an alternative to all of the above, an autosigned script
         *    and a timestamp
         *  - some comments/whitespace or some non-whitespace
         *  - finally, the end of the line
         *
         * It's also localized.
         */
        var sigRgxSrc = "(?:" + /\[\[\s*(?:m:)?:?\s*/.source + "(" + userspcLinkRgx.both +
                /([^\]]|\](?!\]))*?/.source + ")" + /\]\]\)?/.source + "(" +
                /[^\[]|\[(?!\[)|\[\[/.source + "(?!" + userspcLinkRgx.both +
                "))*?" + DATE_FMT_RGX[mw.config.get( "wgServer" )] +
                /\s+\(UTC\)|class\s*=\s*"autosigned".+?\(UTC\)<\/small>/.source +
                ")" + /(\S*([ \t\f]|<!--.*?-->)*(?:\{\{.+?\}\})?(?!\S)|\s?\S+([ \t\f]|<!--.*?-->)*)$/.source;
        var sigRgx = new RegExp( sigRgxSrc, "igm" );
        var matchIdx = 0;
        var match;
        var matchIdxEnd;
        var dstSpnIdx;

        sigMatchLoop:
        for( ; true ; matchIdx++ ) {
            match = sigRgx.exec( sectionWikitext );
            if( !match ) {
                console.error("[sigIdxToStrIdx] out of matches, matchIdx was",matchIdx,"sigIdx was",sigIdx);
                return -1;
            }
            //console.log( "sig match (matchIdx = " + matchIdx + ") is >" + match[0] + "< (index = " + match.index + ")" );

            matchIdxEnd = match.index + match[0].length;

            // Validate that we're not inside a delsort span
            for( dstSpnIdx = 0; dstSpnIdx < spanStartIndices.length; dstSpnIdx++ ) {
                //console.log(spanStartIndices[dstSpnIdx],match.index,
                //    matchIdxEnd, spanStartIndices[dstSpnIdx] +
                //        spanLengths[dstSpnIdx] );
                if( match.index > spanStartIndices[dstSpnIdx] &&
                    ( matchIdxEnd <= spanStartIndices[dstSpnIdx] +
                        spanLengths[dstSpnIdx] ) ) {

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
        //console.log("slicedSecWikitext = >>" + slicedSecWikitext.slice(0,50) + "<<");
        slicedSecWikitext = slicedSecWikitext.replace( /^\n/, "" );
        var candidateLines = slicedSecWikitext.split( "\n" );
        //console.log( "candidateLines =", candidateLines );

        // number of the line in sectionWikitext that'll be right after reply
        var replyLine = 0;

        var INDENT_RE = /^[:*#]+/;
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
                //console.log(i + ">" + candidateLines[i] + "< => " + currIndentationLvl);

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
                        //console.log( "cIL <= iL, breaking" );
                        break;
                    }
                } else {
                    replyLine = i + 1;
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

        //console.log( "replyLine = " + replyLine );

        // Splice into slicedSecWikitext
        slicedSecWikitext = candidateLines
            .slice( 0, replyLine )
            .concat( [ fullReply ], candidateLines.slice( replyLine ) )
            .join( "\n" );

        // We may need an additional newline if the two slices don't have any
        var optionalNewline = ( !sectionWikitext.slice( 0, strIdx ).endsWith( "\n" ) &&
                    !slicedSecWikitext.startsWith( "\n" ) ) ? "\n" : "";

        // Splice into sectionWikitext
        sectionWikitext = sectionWikitext.slice( 0, strIdx ) +
            optionalNewline + slicedSecWikitext;

        return sectionWikitext;
    }

    function performInPlaceReload( sigLinkElem, sectionObj ) {
        return $.getJSON(
            mw.util.wikiScript( "api" ),
            {
                format: "json",
                action: "parse",
                prop: "text",
                section: sectionObj.idxInDomHeaders + 1,
                page: sectionObj.pageTitle,
                formatversion: 2,
            }
        ).then( function ( parseResult ) {
            if( parseResult.parse.text ) {
                var cmtLinkPath = getPathToElement( sigLinkElem );

                // Delete all DOM elements in the current section
                var nextHeaderEl = allContentHeaders()[sectionObj.idxInDomHeaders + 1];
                var currEl = sectionObj.headerEl.nextElementSibling;
                while( currEl && ( currEl !== nextHeaderEl ) ) {
                    var nextEl = currEl.nextElementSibling;
                    currEl.parentNode.removeChild( currEl );
                    currEl = nextEl;
                }

                // Now write in the new stuff
                var newHtml = new DOMParser().parseFromString( parseResult.parse.text, "text/html" );

                // Select inside of .mw-parser-output
                newHtml = newHtml.querySelector( ".mw-parser-output" );

                // Remove initial header
                newHtml.removeChild( newHtml.children[0] );

                $( sectionObj.headerEl ).after( newHtml.children );
                mw.hook( "wikipage.content" ).fire( $( newHtml.children ) );

                delete getWikitextCache[sectionObj.pageTitle];

                var newCmtLink = followPathToElement( cmtLinkPath );
                highlightContainerOf( newCmtLink );
            } else {
                console.error( parseResult );
                setStatus( "Failed to load in new version." );
            }
        } );
    }

    /**
     * Using the text in #reply-dialog-field, add a reply to the current page.
     * rplyToXfdNom is true if we're replying to an XfD nom, in which case we
     * should use an asterisk instead of a colon.  revObj is the object returned
     * by getWikitext for the page with the comment; sectionObj is the object
     * returned by findSectionMain for the comment.
     *
     * Returns a Deferred that resolves/rejects when the reply succeeds/fails.
     */
    function doReply( parentCmtObj, cmtAuthorAndLink, rplyToXfdNom, sectionObj, canMakeSectionEdit ) {
        var deferred = $.Deferred();

        var revObj = sectionObj.revObj;
        var wikitext = revObj.content;

        try {

            // Generate reply in wikitext form
            var reply = document.getElementById( "reply-dialog-field" ).value.trim();

            // Add a signature if one isn't already there
            if( !hasSig( reply ) ) {
                reply += " " + ( window.replyLinkSigPrefix ?
                    window.replyLinkSigPrefix : "" ) + LITERAL_SIGNATURE;
            }

            var isUsingAutoIndentation = window.replyLinkAutoIndentation === "checkbox"
                ? ( !document.getElementById( "reply-link-option-auto-indent" ) ||
                    document.getElementById( "reply-link-option-auto-indent" ).checked )
                : window.replyLinkAutoIndentation === "always";
            if( isUsingAutoIndentation ) {

                var replyLines = reply.split( "\n" );

                // If we're outdenting, reset indentation and add the
                // outdent template. This requires that there be at least
                // one character of indentation.
                var outdentCheckbox = document.getElementById( "reply-link-option-outdent" );
                if( outdentCheckbox && outdentCheckbox.checked ) {
                    replyLines[0] = "{" + "{od|" + parentCmtObj.indentation.slice( 0, -1 ) +
                        "}}" + replyLines[0];
                    parentCmtObj.indentation = "";
                }

                // Compose reply by adding indentation at the beginning of
                // each line (if not replying to an XfD nom) or {{pb}}'s
                // between lines (if replying to an XfD nom)
                var fullReply;
                if( rplyToXfdNom ) {

                    // If there's a list in this reply, it's a bad idea to
                    // use pb's, even though the markup'll probably be broken
                    if( replyLines.some( function ( l ) { return l.substr( 0, 1 ) === "*"; } ) ) {
                        fullReply = replyLines.map( function ( line ) {
                            return parentCmtObj.indentation + "*" + line;
                        } ).join( "\n" );
                    } else {
                        fullReply = parentCmtObj.indentation + "* " + replyLines.join( "{{pb}}" );
                    }
                } else {
                    fullReply = replyLines.map( function ( line ) {
                        return parentCmtObj.indentation + ":" + line;
                    } ).join( "\n" );
                }
            } else {
                fullReply = reply;
            }

            var sectionWikitext = wikitext.slice( sectionObj.startIdx, sectionObj.endIdx )
                .trim(); // extra whitespace just messes stuff up
            var oldSectionWikitext = sectionWikitext; // We'll String.replace old w/ new

            // Now, obtain the index of the end of the comment
            var strIdx = parentCmtObj.endStrIdx || sigIdxToStrIdx( sectionWikitext, parentCmtObj.sigIdx );
            //console.log(">"+sectionWikitext.substring(strIdx)+"<");

            // Check for a non-negative strIdx
            if( strIdx < 0 ) {
                throw( "Negative strIdx (signature not found in wikitext)" );
            }

            // Determine the user who wrote the comment, for
            // edit-summary and sanity-check purposes
            var userRgx = new RegExp( /\[\[\s*(?:m:)?:?\s*/.source + userspcLinkRgx.both + /\s*(.+?)(?:\/.+?)?(?:#.+?)?\s*(?:\|.+?)?\]\]/.source, "ig" );
            var userMatches = processCharEntitiesWikitext( sectionWikitext.slice( 0, strIdx ) ).match( userRgx );
            var cmtAuthorWktxt = userRgx.exec( userMatches[userMatches.length - 1] )[1];

            if( cmtAuthorWktxt === "DoNotArchiveUntil" ) {
                userRgx.lastIndex = 0;
                cmtAuthorWktxt = userRgx.exec( userMatches[userMatches.length - 2] )[1];
            }

            // Normalize case, because that's what happens during
            // wikitext-to-HTML processing; also underscores to spaces
            function sanitizeUsername( u ) {
                u = u.charAt( 0 ).toUpperCase() + u.substr( 1 );
                return u.replace( /_/g, " " );
            }
            cmtAuthorWktxt = sanitizeUsername( cmtAuthorWktxt );
            var cmtAuthorDom = sanitizeUsername( cmtAuthorAndLink.username );

            // Is the sig username the same as the DOM one?  We attempt to check
            // sigRedirectMapping in case the naive check fails
            if( cmtAuthorWktxt !== cmtAuthorDom &&
                    processCharEntitiesWikitext( cmtAuthorWktxt ) !== cmtAuthorDom &&
                    sigRedirectMapping[ cmtAuthorWktxt ] !== cmtAuthorDom ) {
                throw new Error( "Sig username assert failed! Found " +
                    cmtAuthorWktxt + " but expected " + cmtAuthorDom +
                    " (wikitext vs DOM)" );
            }

            // Another check: timestamp
            var htmlTimestamp = getTimestampGivenAuthorLink( cmtAuthorAndLink.link );
            var textTimestampMatches = sectionWikitext.slice( 0, strIdx ).match( new RegExp( DATE_FMT_RGX[mw.config.get( "wgServer" )], "g" ) );
            if( textTimestampMatches.length > 0 ) {
                var textTimestamp = textTimestampMatches[ textTimestampMatches.length - 1 ];
                if( htmlTimestamp !== textTimestamp ) {
                    throw new Error( "Timestamp assert failed! HTML had '" + htmlTimestamp + "' but wikitext had '" + textTimestamp + "'" );
                }
            } else {
                console.warn( "textTimestampMatches was empty" );
            }

            // Actually insert our reply into the section wikitext
            sectionWikitext = insertTextAfterIdx( sectionWikitext, strIdx,
                    parentCmtObj.indentation.length, fullReply );

            // Also, if the user wanted the edit request to be answered, do that
            var editReqCheckbox = document.getElementById( "reply-link-option-edit-req" );
            var markedEditReq = false;
            if( editReqCheckbox && editReqCheckbox.checked ) {
                sectionWikitext = markEditReqAnswered( sectionWikitext );
                markedEditReq = true;
            }

            // If the user preferences indicate a dry run, print what the
            // wikitext would have been post-edit and bail out
            var dryRunCheckbox = document.getElementById( "reply-link-option-dry-run" );
            if( window.replyLinkDryRun === "always" || ( dryRunCheckbox && dryRunCheckbox.checked ) ) {
                console.log( "~~~~~~ DRY RUN CONCLUDED ~~~~~~" );
                console.log( sectionWikitext );
                setStatus( "Check the console for the dry-run results." );
                document.querySelector( "#reply-link-buttons button" ).disabled = false;
                deferred.resolve();
                return deferred;
            }

            // Build summary
            var defaultSummmary = mw.msg( "rl-replying-to" ) +
                ( rplyToXfdNom ? xfdType + " nomination by " : "" ) +
                cmtAuthorWktxt +
                ( markedEditReq ? " and marking edit request as answered" : "" );
            var customSummaryField = document.getElementById( "reply-link-summary" );
            var summaryCore = defaultSummmary;
            if( window.replyLinkCustomSummary && customSummaryField.value ) {
                summaryCore = customSummaryField.value.trim();
            }
            var sectionId = sectionObj.headerEl ? sectionObj.headerEl.querySelector( "span.mw-headline" ).id : sectionObj.title;
            var summary = "/* " + sectionId.replace( /_/g, " " ) + " */ " + summaryCore + mw.msg( "rl-advert" );

            var editParams = {
                action: "edit",
                title: sectionObj.pageTitle,
                summary: summary,
                basetimestamp: revObj.timestamp,
            };

            if( canMakeSectionEdit && ( sectionObj.idxInDomHeaders !== null ) ) {
                editParams.section = sectionObj.idxInDomHeaders + 1;
                if( sectionWikitext.startsWith( oldSectionWikitext ) ) {
                    editParams.appendtext = "\n" + sectionWikitext.substring( oldSectionWikitext.length ).trim();
                } else {
                    editParams.text = sectionWikitext;
                }
            } else {
                var newWikitext = wikitext.replace( oldSectionWikitext, sectionWikitext );
                editParams.text = newWikitext;
            }

            // Send another request, this time to actually edit the page
            api.postWithEditToken( editParams ).done ( function ( data ) {

                // We put this function on the window object because we
                // give the user a "reload" link, and it'll trigger the function.
                // TODO goodness knows why I made this a property on the window object
                window.replyLinkReload = function () {
                    window.location.hash = sectionId;
                    var path = getPathToElement( cmtAuthorAndLink.link );
                    document.cookie = JUMP_COOKIE_KEY + "=" + path;
                    window.location.reload( true );
                };

                if ( data && data.edit && data.edit.result && data.edit.result == "Success" ) {
                    var needPurge = sectionObj.pageTitle !== currentPageName.replace( /_/g, " " );

                    function finishReply( _ ) {
                        if( canMakeSectionEdit && window.replyLinkAutoReload && window.replyLinkLoadNewInPlace ) {
                            performInPlaceReload( cmtAuthorAndLink.link, sectionObj );
                        } else {
                            var reloadHtml = window.replyLinkAutoReload ? mw.msg( "rl-reloading" )
                                : "<a href='javascript:window.replyLinkReload()' class='reply-link-reload'>" + mw.msg( "rl-reload" ) + "</a>";
                            setStatus( mw.msg( "rl-saved" ) + " (" + reloadHtml + ")" );

                            // Required to permit reload to happen, checked in onbeforeunload
                            replyWasSaved = true;

                            if( window.replyLinkAutoReload ) {
                                window.replyLinkReload();
                            }

                            deferred.resolve();
                        }
                    }

                    if( needPurge ) {
                        setStatus( "Reply saved! Purging..." );
                        api.post( { action: "purge", titles: currentPageName } ).done( finishReply );
                    } else {
                        finishReply();
                    }
                } else {
                    if( data && data.edit && data.edit.spamblacklist ) {
                        setStatus( "Error! Your post contained a link on the <a href=" +
                            "\"https://en.wikipedia.org/wiki/Wikipedia:Spam_blacklist\"" +
                            ">spam blacklist</a>. Remove the link(s) to: " +
                            data.edit.spamblacklist.split( "|" ).join( ", " ) + " to allow saving." );
                        document.querySelector( "#reply-link-buttons button" ).disabled = false;
                    } else {
                        setStatus( "While saving, the edit query returned an error." +
                            " Check the browser console for more information." );
                    }

                    deferred.reject();
                }
                //console.log(data);
                document.getElementById( "reply-dialog-field" ).style["background-image"] = "";
            } ).fail ( function( code, result ) {
                setStatus( mw.msg( "rl-edit-fail" ) );
                console.log(code);
                console.log(result);
                deferred.reject();
            } );
        } catch ( e ) {
            setStatusError( e );
            deferred.reject();
        }

        return deferred;
    }

    function checkCanMakeSectionEdit( sectionObj ) {
        var fullWikitext = sectionObj.revObj.content;

        if( sectionObj.idxInDomHeaders === null ) {
            return $.when( false );
        }

        // First, check if includeonly and noinclude are gonna ruin our day, by
        // seeing if there are any section headers inside includeonly and
        // noinclude elements.
        var disruptiveSectionRegex = /<(includeonly|noinclude)>[\s\S]+?==[\s\S]+?<\/(\1)>/;
        if( disruptiveSectionRegex.test( fullWikitext ) ) {
            return $.when( false );
        }

        return $.getJSON(
            mw.util.wikiScript( "api" ),
            {
                format: "json",
                action: "parse",
                prop: "wikitext",
                section: sectionObj.idxInDomHeaders + 1,
                page: sectionObj.pageTitle,
                formatversion: 2,
            }
        ).then( function ( parseResult ) {
            var parseSectionWikitext = parseResult.parse.wikitext;
            var officialSectionWikitext = fullWikitext.slice( sectionObj.startIdx, sectionObj.endIdx )
                .trim();
            // Trim because parseSectionWikitext also gets trimmed by the API
            if( officialSectionWikitext !== parseSectionWikitext ) {
                // Bit of debug info
                /*
                console.log( "oswlen",officialSectionWikitext.length,"pswlen",parseSectionWikitext.length );
                for ( var i = 0; i < Math.max( officialSectionWikitext.length, parseSectionWikitext.length ); i++  ) {
                    if( officialSectionWikitext[i] !== parseSectionWikitext[i] ) {
                        console.log( 'osw substr',
                            JSON.stringify( officialSectionWikitext.substring( i ) ),
                            'psw substr',
                            JSON.stringify( parseSectionWikitext.substring( i ) ) );
                        break;
                    }
                }
                */
            }
            return officialSectionWikitext === parseSectionWikitext;
        } );
    }

    function handleWrapperClick( linkLabel, parent, rplyToXfdNom, parentCmtObj, sectionObj ) {
        return function ( evt ) {
            $.when( mw.messages.exists( INT_MSG_KEYS[0] ) ? 1 :
                    api.loadMessages( INT_MSG_KEYS ) ).then( function () {
                var newLink = this;
                var newLinkWrapper = this.parentNode;

                if( !userspcLinkRgx ) {
                    buildUserspcLinkRgx();
                }

                // Remove previous panel
                var prevPanel = document.getElementById( "reply-link-panel" );
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
                    newLink.textContent = mw.msg( "rl-cancel" ) + linkLabel;
                } else {

                    // We've already cancelled the reply
                    newLink.textContent = linkLabel;
                    evt.preventDefault();
                    return false;
                }

                // Figure out the username of the author
                // of the comment we're replying to
                var cmtAuthorAndLink = getCommentAuthor( newLinkWrapper );

                try {
                    var cmtAuthor = cmtAuthorAndLink.username,
                        cmtLink = cmtAuthorAndLink.link;
                } catch ( e ) {
                    setStatusError( e );
                }

                // Create panel
                var panelEl = document.createElement( "div" );
                panelEl.id = "reply-link-panel";
                panelEl.innerHTML = "<textarea id='reply-dialog-field' class='mw-ui-input'" +
                    " placeholder='" + mw.msg( "rl-placeholder" ) + "'></textarea>" +
                    ( window.replyLinkCustomSummary ? "<label for='reply-link-summary'>Summary: </label>" +
                        "<input id='reply-link-summary' class='mw-ui-input' placeholder='Edit summary' " +
                        "value='Replying to " + cmtAuthor.replace( /'/g, "&#39;" ) + "'/><br />" : "" ) +
                    "<table style='border-collapse:collapse'><tr><td id='reply-link-buttons' style='width: " +
                    ( window.replyLinkPreloadPing === "button" ? "325" : "255" ) + "px'>" +
                    "<button id='reply-dialog-button' class='mw-ui-button mw-ui-progressive'>" + mw.msg( "rl-reply" ) + "</button> " +
                    "<button id='reply-link-preview-button' class='mw-ui-button'>" + mw.msg( "rl-preview" ) + "</button>" +
                    ( window.replyLinkPreloadPing === "button" ?
                        " <button id='reply-link-ping-button' class='mw-ui-button'>Ping</button>" : "" ) +
                    "<button id='reply-link-cancel-button' class='mw-ui-button mw-ui-quiet mw-ui-destructive'>" + mw.msg( "rl-cancel-button" ) + "</button></td>" +
                    "<td id='reply-dialog-status'></span><div style='clear:left'></td></tr></table>" +
                    "<div id='reply-link-options' class='gone-on-empty' style='margin-top: 0.5em'></div>" +
                    "<div id='reply-link-preview' class='gone-on-empty' style='border: thin dashed gray; padding: 0.5em; margin-top: 0.5em'></div>";
                parent.insertBefore( panelEl, newLinkWrapper.nextSibling );
                var replyDialogField = document.getElementById( "reply-dialog-field" );
                replyDialogField.style = "padding: 0.625em; min-height: 10em; margin-bottom: 0.75em; line-height: 1.3";
                if( window.replyLinkPreloadPing === "always" &&
                        cmtAuthor &&
                        cmtAuthor !== mw.config.get( "wgUserName" ) &&
                        !/(\d+.){3}\d+/.test( cmtAuthor ) ) {
                    replyDialogField.value = window.replyLinkPreloadPingTpl.replace( "##", cmtAuthor );
                }

                // Fill up #reply-link-options
                function newOption( id, text, defaultOn ) {
                    var newCheckbox = document.createElement( "input" );
                    newCheckbox.type = "checkbox";
                    newCheckbox.id = id;
                    if( defaultOn ) {
                        newCheckbox.checked = true;
                    }
                    var newLabel = document.createElement( "label" );
                    newLabel.htmlFor = id;
                    newLabel.appendChild( document.createTextNode( text ) );
                    document.getElementById( "reply-link-options" ).appendChild( newCheckbox );
                    document.getElementById( "reply-link-options" ).appendChild( newLabel );
                }

                if( parentCmtObj.sigIdx === null && parentCmtObj.endStrIdx === null ) {
                    parentCmtObj.sigIdx = metadata[this.id].sigIdx;
                }

                // If the dry-run option is "checkbox", add an option to make it
                // a dry run
                if( window.replyLinkDryRun === "checkbox" ) {
                    newOption( "reply-link-option-dry-run", "Don't actually edit?", true );
                }

                // If the current section header text indicates an edit request,
                // offer to mark it as answered
                //if( ourMetadata[1] && EDIT_REQ_REGEX.test( ourMetadata[1][1] ) ) {
                //    newOption( "reply-link-option-edit-req", "Mark edit request as answered?", false );
                //}

                // If the previous comment was indented by OUTDENT_THRESH,
                // offer to outdent
                if( parentCmtObj.indentation.length >= OUTDENT_THRESH ) {
                    newOption( "reply-link-option-outdent", "Outdent?", false );
                }

                if( window.replyLinkAutoIndentation === "checkbox" ) {
                    newOption( "reply-link-option-auto-indent", mw.msg( "rl-auto-indent" ), true );
                }

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

                // Close handler
                window.onbeforeunload = function ( e ) {
                    if( !replyWasSaved &&
                            document.getElementById( "reply-dialog-field" ) &&
                            document.getElementById( "reply-dialog-field" ).value ) {
                        var txt = mw.msg( "rl-started-reply" );
                        e.returnValue = txt;
                        return txt;
                    }
                };

                // Start loading in the section object, so we don't have to do it in startReply
                try {
                    var sectionObjPromise = ( sectionObj === null ) ? findSectionMain( cmtLink ) : $.when( sectionObj );
                } catch ( e ) {
                    console.error( e );
                    setStatus( "Error locating the section: " + e );
                    document.querySelector( "#reply-link-buttons button" ).disabled = true;
                }

                // Also, check if we can get away with sending just a section edit
                var canMakeSectionEditPromise = sectionObjPromise.then( checkCanMakeSectionEdit );

                // Called by the "Reply" button, Ctrl-Enter in the text area, and
                // Enter/Ctrl-Enter in the summary field
                function startReply() {

                    // Change UI to make it clear we're performing an operation
                    document.getElementById( "reply-dialog-field" ).style["background-image"] =
                        "url(" + window.replyLinkPendingImageUrl + ")";
                    document.querySelector( "#reply-link-buttons button" ).disabled = true;
                    setStatus( mw.msg( "rl-loading" ) );

                    var revidCheckPromise = sectionObjPromise.then( function ( sectionObj ) {
                        return getLastRevId( sectionObj.pageTitle );
                    } );

                    $.when(
                        sectionObjPromise,
                        revidCheckPromise,
                        canMakeSectionEditPromise,
                    ).then( function ( sectionObj, currentRevId, canMakeSectionEdit ) {
                        if( currentRevId > sectionObj.pageRevId ) {
                            // Someone's edited this page since we parsed it
                            setStatus( mw.msg( "rl-out-of-date" ) );
                        } else {
                            doReply(
                                parentCmtObj,
                                cmtAuthorAndLink,
                                rplyToXfdNom,
                                sectionObj,
                                canMakeSectionEdit
                            );
                        }
                    }, function ( err ) {
                        console.error( err );
                        setStatus( "Error (async), probably while locating the section: " + err );
                    } );
                }

                // Event listener for the "Reply" button
                document.getElementById( "reply-dialog-button" )
                    .addEventListener( "click", startReply );

                // Event listener for the text area
                document.getElementById( "reply-dialog-field" )
                    .addEventListener( "keydown", function ( e ) {
                        if( e.ctrlKey && ( e.keyCode == 10 || e.keyCode == 13 ) ) {
                            startReply();
                        }
                    } );

                // Event listener for the "Preview" button
                document.getElementById( "reply-link-preview-button" )
                    .addEventListener( "click", function () {
                        var reply = document.getElementById( "reply-dialog-field" ).value.trim();

                        // Add a signature if one isn't already there
                        if( !hasSig( reply ) ) {
                            reply += " " + ( window.replyLinkSigPrefix ?
                                window.replyLinkSigPrefix : "" ) + LITERAL_SIGNATURE;
                        }

                        var sanitizedCode = encodeURIComponent( reply );
                        sectionObjPromise.then( function ( sectionObj ) {
                            $.post( "https:" + mw.config.get( "wgServer" ) +
                                "/w/api.php?action=parse&format=json&title=" +
                                    encodeURIComponent( sectionObj.pageTitle ) + "&text=" + sanitizedCode +
                                    "&pst=1&prop=text&formatversion=2",
                                function ( res ) {
                                    if ( !res || !res.parse || !res.parse.text ) return console.error( "Preview failed" );
                                    document.getElementById( "reply-link-preview" ).innerHTML = res.parse.text;
                                    // Add target="_blank" to links to make them open in a new tab by default
                                    var links = document.querySelectorAll( "#reply-link-preview a" );
                                    for( var i = 0, n = links.length; i < n; i++ ) {
                                        links[i].setAttribute( "target", "_blank" );
                                    }
                                } );
                        } );
                    } );

                if( window.replyLinkPreloadPing === "button" ) {
                    document.getElementById( "reply-link-ping-button" )
                        .addEventListener( "click", function () {
                            replyDialogField.value = window.replyLinkPreloadPingTpl
                                .replace( "##", cmtAuthor ) + replyDialogField.value;
                        } );
                }

                // Event listener for the "Cancel" button
                document.getElementById( "reply-link-cancel-button" )
                    .addEventListener( "click", function () {
                        newLink.textContent = linkLabel;
                        panelEl.remove();
                    } );

                // Event listeners for the custom edit summary field
                if( window.replyLinkCustomSummary ) {
                    document.getElementById( "reply-link-summary" )
                        .addEventListener( "keydown", function ( e ) {
                            if( e.keyCode == 10 || e.keyCode == 13 ) {
                                startReply();
                            }
                        } );
                }

                if( newLinkWrapper.dataset.replyLinkInstant === true ) {
                    startReply();
                    newLinkWrapper.dataset.replyLinkInstant = false;
                }

                if( window.replyLinkTestInstantReply ) {
                    startReply();
                }
            }.bind( this ) );

            // Cancel default event handler
            evt.preventDefault();
            return false;
        }
    }

    /**
     * Adds a "(reply)" link after the provided text node, giving it
     * the provided element id. anyIndentation is true if there's any
     * indentation (i.e. indentation string is not the empty string)
     */
    function attachLinkAfterNode( node, preferredId, parentCmtObj, sectionObj ) {

        // Choose a parent node - walk up tree until we're under a dd, li,
        // p, or div. This walk is a bit unsafe, but this function should
        // only get called in a place where the walk will succeed.
        var parent = node;
        do {
            parent = parent.parentNode;
        } while( !( /^(p|dd|li|div|td)$/.test( parent.tagName.toLowerCase() ) ) );

        // Determine whether we're replying to an XfD nom
        var rplyToXfdNom = false;
        if( xfdType === "AfD" || xfdType === "MfD" ) {

            // If the parent comment is non-indented, we are replying to a nom
            rplyToXfdNom = !parentCmtObj.sigIdx;
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
        var linkLabel = mw.msg( "rl-reply-label" ) + ( rplyToXfdNom ? mw.msg( "rl-to-label" ) + xfdType : "" );

        // Construct new link
        var newLinkWrapper = document.createElement( "span" );
        newLinkWrapper.className = "reply-link-wrapper";
        var newLink = document.createElement( "a" );
        newLink.href = "#";
        newLink.id = preferredId;
        newLink.dataset.originalLabel = linkLabel;
        newLink.appendChild( document.createTextNode( linkLabel ) );
        newLink.addEventListener( "click", handleWrapperClick( linkLabel, parent, rplyToXfdNom, parentCmtObj, sectionObj ) );
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
        if( !mainContent ) {
            console.error( "No main content element found; exiting." );
            return;
        }

        var contentEls = mainContent.children;

        // Find the index of the first header in contentEls
        var headerIndex = 0;
        for( headerIndex = 0; headerIndex < contentEls.length; headerIndex++ ) {
            if( contentEls[ headerIndex ].matches( HEADER_SELECTOR ) ) break;
        }

        // If we didn't find any headers at all, that's a problem and we
        // should bail
        if( mainContent.querySelector( "div.hover-edit-section" ) ) {
            headerIndex = 0;
        } else if( headerIndex === contentEls.length ) {
            console.error( "Didn't find any headers - hit end of loop!" );
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
                node.className.includes( "localcomments" );

            var isSmall = node.nodeType === 1 && (
                    node.tagName.toLowerCase() === "small" ||
                    ( node.tagName.toLowerCase() === "span" &&
                    node.style && node.style.getPropertyValue( "font-size" ) === "85%" ) );

            // Small nodes are okay, unless they're delsort notices
            var isOkSmallNode = isSmall &&
                !node.className.includes( "delsort-notice" );

            if( ( node.nodeType === 3 ) ||
                    isOkSmallNode ||
                    isLocalCommentsSpan )  {

                // If the current node has a timestamp, attach a link to it
                // Also, no links after timestamps, because it's just like
                // having normal text afterwards, which is rejected (because
                // that means someone put a timestamp in the middle of a
                // paragraph)
                var hasLinkAfterwardsNotInBlockEl = node.nextElementSibling &&
                    ( node.nextElementSibling.tagName.toLowerCase() === "a" ||
                        ( node.nextElementSibling.tagName.match( /^(span|small)$/i ) &&
                            node.nextElementSibling.querySelector( "a" ) ) );
                if( TIMESTAMP_REGEX.test( node.textContent ) &&
                        ( node.previousSibling || isSmall ) &&
                        !hasLinkAfterwardsNotInBlockEl ) {
                    linkId = "reply-link-" + idNum;
                    var parentCmtObj = {
                        indentation: currIndentation,
                        sigIdx: null,
                        endStrIdx: null
                    };
                    attachLinkAfterNode( node, linkId, parentCmtObj, /* sectionObj */ null );
                    idNum++;

                    // Update global metadata dictionary
                    metadata[linkId] = {};
                    //metadata[linkId].indentation = currIndentation; // It's already being passed into attachLinkAfterNode
                }
            } else if( node.nodeType === 1 &&
                    /^(div|p|dl|dd|ul|li|span|ol|table|tbody|tr|td)$/.test( node.tagName.toLowerCase() ) ) {
                switch( node.tagName.toLowerCase() ) {
                    case "dl": newIndentSymbol = ":"; break;
                    case "ul": newIndentSymbol = "*"; break;
                    case "ol": newIndentSymbol = "#"; break;
                    case "div":
                        if( node.className.includes( "xfd_relist" ) || node.className.includes( "thumbcaption" ) ) {
                            continue;
                        }
                        break;
                    default: newIndentSymbol = ""; break;
                }

                var childNodes = node.childNodes;
                for( let i = 0, numNodes = childNodes.length; i < numNodes; i++ ) {
                    parseStack.push( [ currIndentation + newIndentSymbol,
                        childNodes[i] ] );
                }
            }
        }

        // This loop adds sigIdx entries in the metadata dictionary
        var sigIdxEls = iterableToList( mainContent.querySelectorAll(
                HEADER_SELECTOR + ",span.reply-link-wrapper a" ) );
        var currSigIdx = 0, j, numSigIdxEls, currHeaderEl, currHeaderData;
        var headerIdx = 0; // index of the current header
        var headerLvl = 0; // level of the current header
        for( j = 0, numSigIdxEls = sigIdxEls.length; j < numSigIdxEls; j++ ) {
            var headerTagNameMatch = /^h(\d+)$/.exec(
                sigIdxEls[j].tagName.toLowerCase() );
            if( headerTagNameMatch ) {
                currHeaderEl = sigIdxEls[j];

                // Test to make sure we're not in the table of contents
                if( currHeaderEl.parentNode.className === "toctitle" ) {
                    continue;
                }

                // Reset signature counter
                currSigIdx = 0;
            } else {
                metadata[ sigIdxEls[j].id ].sigIdx = currSigIdx;
                currSigIdx++;
            }
        }

        // Disable links inside hatnotes, archived discussions
        var badRegionsSelector = "div.archived,div.resolved,table";
        var badRegions = mainContent.querySelectorAll( badRegionsSelector );
        for( var i = 0; i < badRegions.length; i++ ) {
            var badRegion = badRegions[i];
            var insideArchived = badRegion.querySelectorAll( ".reply-link-wrapper" );
            for( var j = 0; j < insideArchived.length; j++ ) {
                insideArchived[j].parentNode.removeChild( insideArchived[j] );
            }
        }
    }

    function runTestMode() {

        // We never want to make actual edits
        window.replyLinkDryRun = "always";

        // Simulate having a panel open
        $( "#mw-content-text" )
            .append( $( "<div>" )
                .append( $( "<textarea>" ).attr( "id", "reply-dialog-field" ).val( "hi" ) )
                .append( $( "<div>" ).attr( "id", "reply-link-buttons" )
                    .append( $( "<button> " ) ) ) );

        mw.util.addCSS( ".reply-link-wrapper { background-color: orange; }" );

        api.loadMessages( INT_MSG_KEYS ).then( function () {
            buildUserspcLinkRgx();

            // Statistics variables
            var successes = 0, failures = 0;

            // Run one test on a wrapper link
            function runOneTestOn( wrapper ) {
                try {
                    var cmtAuthorAndLink = getCommentAuthor( wrapper );
                    var ourMetadata = metadata[ wrapper.children[0].id ];
                    findSectionMain( cmtAuthorAndLink.link ).then( function ( sectionObj ) {
                        doReply(
                            ourMetadata.indentation,
                            ourMetadata.sigIdx,
                            cmtAuthorAndLink,
                            /* rplyToXfdNom */ false,
                            sectionObj
                        ).done( function () {
                            wrapper.style.background = "green";
                            successes++;
                        } ).fail( function () {
                            wrapper.style.background = "red";
                            failures++;
                        } );
                    } );
                } catch ( e ) {
                    console.error( e );
                    wrapper.style.background = "red";
                    failures++;
                }
            }

            var wrappers = Array.from( document.querySelectorAll( ".reply-link-wrapper" ) );
            function runOneTest() {
                var wrapper = wrappers.shift();
                if( wrapper ) {
                    runOneTestOn( wrapper );
                    setTimeout( runOneTest, 250 );
                } else {
                    var results = successes + " successes, " + failures + " failures";
                    $( "#mw-content-text" ).prepend( results ).append( results );
                }
            }
            //console.log = function() {};
            setTimeout( runOneTest, 0 );
        } );
    }

    function onReady() {
        var lang_code = mw.config.get( "wgUserLanguage" )
        // Replace default English interface by translation if available
        var interface_messages = $.extend( {}, i18n.en, i18n[ lang_code.split('-')[0] ], i18n[ lang_code ] );
        // Define interface messages
        mw.messages.set( interface_messages );

        // Exit if history page or edit page or oldid
        if( mw.config.get( "wgAction" ) === "history" ) return;
        if( document.getElementById( "editform" ) ) return;
        if( window.location.search.includes( "oldid=" ) ) return;

        api = new mw.Api();

        mw.util.addCSS(
            "#reply-link-panel { padding: 1em; margin-left: 1.6em; "+
              "max-width: 1200px; width: 66%; margin-top: 0.5em; }"+
            ".gone-on-empty:empty { display: none; }"
        );
        mw.loader.load( "https://en.wikipedia.org/w/index.php?title=User:Enterprisey/mw-ui-button.css&action=raw&ctype=text/css", "text/css" );

        // Pre-load interface messages; we will check again when a (reply)
        // link is clicked
        api.loadMessages( INT_MSG_KEYS );

        // Initialize the xfdType global variable, which must happen
        // before the call to attachLinks
        currentPageName = mw.config.get( "wgPageName" );
        xfdType = "";
        if( mw.config.get( "wgNamespaceNumber" ) === 4) {
            if( currentPageName.startsWith( "Wikipedia:Articles_for_deletion/" ) ) {
                xfdType = "AfD";
            } else if( currentPageName.startsWith( "Wikipedia:Miscellany_for_deletion/" ) ) {
                xfdType = "MfD";
            } else if( currentPageName.startsWith( "Wikipedia:Templates_for_discussion/Log/" ) ) {
                xfdType = "TfD";
            } else if( currentPageName.startsWith( "Wikipedia:Categories_for_discussion/Log/" ) ) {
                xfdType = "CfD";
            } else if( currentPageName.startsWith( "Wikipedia:Files_for_discussion/" ) ) {
                xfdType = "FfD";
            }
        }

        // Default values for some preferences
        function defaultValue( prefName, defaultValue ) { if( window[prefName] === undefined ) window[prefName] = defaultValue; }
        defaultValue( "replyLinkAutoReload",       !isOnSectionWatchlistPage );
        defaultValue( "replyLinkDryRun",           "never" );
        defaultValue( "replyLinkPreloadPing",      "always" );
        defaultValue( "replyLinkPreloadPingTpl",   "{{u|##}}, " );
        defaultValue( "replyLinkCustomSummary",    false );
        defaultValue( "replyLinkTestMode",         false );
        defaultValue( "replyLinkTestInstantReply", false );
        defaultValue( "replyLinkAutoIndentation",  "checkbox" );
        defaultValue( "replyLinkLoadNewInPlace",   true );

        // Insert "reply" links into DOM
        if( !isOnSectionWatchlistPage ) {
            attachLinks();
        }

        // If test mode is enabled, create a link for that
        if( window.replyLinkTestMode &&
                document.getElementsByClassName( "reply-link-sig-check-container" ).length === 0 ) {
            mw.util.addPortletLink( "p-cactions", "#", "reply-link test mode", "pt-reply-link-test" )
                .addEventListener( "click", runTestMode );

            // Also add "sig check" links to each section header
            $( "#mw-content-text" ).find( "h1,h2,h3,h4,h5,h6" ).each( function ( idx, header ) {
                $( header ).find( ".mw-editsection *" ).last().before(
                    "<span style='color: #54595d'> | </span>",
                    $( "<span>", { "class": "reply-link-sig-check-container" } ).append(
                        $( "<a>" )
                            .attr( "href", "#" )
                            .text( "sig check" )
                            .click( function () {
                                //var sigEls = 
                                //var sigMatches;
                            } ) ) );
            } );
        }

        // This large string creats the "pending" texture
        window.replyLinkPendingImageUrl = "data:image/gif;base64,R0lGODlhGAAYAKIGAP7+/vv7+/Ly8u/v7+7u7v///////wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFAAAGACwAAAAAGAAYAAADU0hKAvUwvjCWbTIXahfWEdcxDgiJ3Wdu1UiUK5quUzuqoHzBuZ3yGp0HmBEqcEHfjmYkMZXDp8sZgx6JkiayaKWatFhJd1uckrPWcygdXrvUJ1sCACH5BAUAAAYALAAAAAAYABgAAANTSLokUDBKGAZbbupSr8qb1HlgSFnkY55eo67jVZoxM4c189IoubKtmyaH2W2IH+OwJ1NOkK4fVPhk2pwia1GqTXJbUVg3zANTs2asZHwWpX+cQQIAIfkEBQAABgAsAAAAABgAGAAAA1E4tLwCJcoZQ2uP6hLUJdk2dR8IiRL5hSjnXSyqwmc7Y7X84m21MzHRrZET/oA9V8nUGwKLGqcDSpEybcdpM3vVLYNRLrgqpo7K2685hcaqkwkAIfkEBQAABgAsAAAAABgAGAAAA1RYFUP+TgBFq2IQSstxjhNnNR+xiVVQmiF6kdnpLrDWul58o7k9vyUZrvYQ8oigHy24E/UgzQ4yonwWo6kp62dNzrrbr9YoXZEt4HPWjKWk20CmKwEAIfkEBQAABgAsAAAAABgAGAAAA1NYWjH08Amwam0xTstxlhR3OR+xiYv3nahCrmHLlGbcqpqN4hB7vzmZggcSMoA9nYhYMzJ9O2RRyCQoO1KJM9uUVaFYGtjyvY7E5hR3fC6x1WhRAgAh+QQFAAAGACwAAAAAGAAYAAADVFi6FUMwQgGYVU5Kem3WU9UtH8iN2AMSJ1pq7fhuoquaNXrDubyyvc4shCLtIjHZkVhsLIFN5yopfFIvQ2gze/U8CUHsVxDNam2/rjEdZpjVKTYjAQAh+QQFAAAGACwAAAAAGAAYAAADU1i6G0MwQgGYVU5Kem3WU9U1D0hwI1aCaPqxortq7fjSsT1veXfzqcUuUrOZTj3fEBlUmYrKZ/LyCzULVWYzC6Uuu57vNHwcM7KnKxpMOrKdUkUCACH5BAUAAAYALAAAAAAYABgAAANTWLqsMSTKKEC7b856W9aU1S0fyI0OBBInWmrt+G6iq5q1fMN5N0sx346GSq1YPcwQmLwsQ0XHMShcUZXWpud53WajhR8SLO4yytozN016EthGawIAIfkEBQAABgAsAAAAABgAGAAAA1MoUNzOYZBJ53o41ipwltukeI4WEiMJgWGqmu31sptLwrV805zu4T3V6oTyfYi2H4+SPJ6aDyDTiFmKqFEktmSFRrvbhrQoHMbKhbGX+wybc+hxAgAh+QQFAAAGACwAAAAAGAAYAAADVEgqUP7QhaHqajFPW1nWFEd4H7SJBFZKoSisz+mqpcyRq23hdXvTH10HCEKNiBHhBVZQHplOXtC3Q5qoQyh2CYtaIdsn1CidosrFGbO5RSfb35gvAQAh+QQFAAAGACwAAAAAGAAYAAADU0iqAvUwvjCWbTIXahfWEdcRHzhVY2mKnQqynWOeIzPTtZvBl7yiKd8L2BJqeB7jjti7IRlKyZMUDTGTzis0W6Nyc1XIVJfRep1dslSrtoJvG1QCACH5BAUAAAYALAAAAAAYABgAAANSSLoqUDBKGAZbbupSb3ub1HlZGI1XaXIWCa4oo5ox9tJteof1sm+9xoqS0w2DhBmwKPtNkEoN1Cli2o7WD9ajhWWT1NM3+hyHiVzwlkuemIecBAAh+QQFAAAGACwAAAAAGAAYAAADUxhD3CygyEnlcg3WXQLOEUcpH6GJE/mdaHdhLKrCYTs7sXiDrbQ/NdkLF9QNHUXO79FzlUzJyhLam+Y21ujoyLNxgdUv1fu8SsXmbVmbQrN97l4CACH5BAUAAAYALAAAAAAYABgAAANSWBpD/k4ARetq8EnLWdYTV3kfsYkV9p3oUpphW5AZ29KQjeKgfJU6ES8Su6lyxd2x5xvCfLPlIymURqDOpywbtHCpXqvW+OqOxGbKt4kGn8vuBAAh+QQFAAAGACwAAAAAGAAYAAADU1iqMfTwCbBqbTFOy3GWFHc5H7GJi/edaKFmbEuuYeuWZt2+UIzyIBtjptH9iD2jCJgTupBBIdO3hDalVoKykxU4mddddzvCUS3gc7mkTo2xZmUCACH5BAUAAAYALAAAAAAYABgAAANTWLoaQzBCAZhtT0Z6rdNb1S0fSHAjZp5iWoKom8Ht+GqxPeP1uEs52yrYuYVSpN+kV1SykCoatGBcTqtPKJZ42TK7TsLXExZcy+PkMB2VIrHZQgIAIfkEBQAABgAsAAAAABgAGAAAA1RYuhxDMEIBmFVOSnpt1lPVLR/IjdgDEidaau34bqKrmrV8w3k3RzHfjoZaDIE934qVvPyYxdQqKJw2PUdo9El1ZrtYa7TAvTayBDMJLRg/tbYlJwEAIfkEBQAABgAsAAAAABgAGAAAA1IItdwbg8gphbsFUioUZtpWeV8WiURXPqeorqFLfvH2ljU3Y/l00y3b7tIbrUyo1NBRVB6bv09Qd8wko7yp8al1clFYYjfMHC/L4HOjSF6bq80EACH5BAUAAAYALAAAAAAYABgAAANTSALV/i0MQqtiMEtrcX4bRwkfFIpL6Zxcqhas5apxNZf16OGTeL2wHmr3yf1exltR2CJqmDKnCWqTgqg6YAF7RPq6NKxy6Rs/y9YrWpszT9fAWgIAOw==";


        // Respond to any [[User:Enterprisey/reply-link auto instant reply]] transclusions
        var autoReplies = document.querySelectorAll( ".reply-link-auto-instant-reply" );
        if( autoReplies.length > 0 ) {
            window.replyLinkTestInstantReply = true;
        }
        for( var i = 0; i < autoReplies.length; i++ ) {
            var el = autoReplies[i];
            while( el && el.className !== "reply-link-wrapper" ) {
                el = el.nextElementSibling;
            }
            if( el ) {
                el.dataset.replyLinkInstant = true;
                el.querySelector( "a" ).click();
            }
        }

        // Jump CSS
        mw.loader.addStyleTag( "@keyframes reply-link-jump-highlight-keyframes { from { background-color: #ffb; } to { background-color: transparent; } } .reply-link-jump-highlight { animation: reply-link-jump-highlight-keyframes  2s; }" );

        // Timeout to give other scripts time to load
        setTimeout( function () {

            // If there's an element to jump to, jump to it
            var jumpCookieIdx = document.cookie.indexOf( JUMP_COOKIE_KEY );
            if( jumpCookieIdx >= 0 ) {
                try {
                    var path = new RegExp( JUMP_COOKIE_KEY + "=([^;]+)" ).exec( document.cookie )[1];
                    var el = followPathToElement( path );
                    el.scrollIntoView();
                    highlightContainerOf( el );
                } catch( e ) { console.error(e); }
                document.cookie = JUMP_COOKIE_KEY + "=; expires=Thu, 01 Jan 1970 00:00:01 GMT";
            }
        }, 500 );
    } // end function onReady

    mw.loader.load( "mediawiki.ui.input", "text/css" );
    mw.loader.using( [ "mediawiki.util", "mediawiki.api" ] ).then( function () {
        mw.hook( "wikipage.content" ).add( onReady );
        if( isOnSectionWatchlistPage ) {
            mw.hook( "replylink.attachlinkafter" ).add( attachLinkAfterNode );
        }
    } );

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
if( jQuery !== undefined && mediaWiki !== undefined ) {
    var currNamespace = mw.config.get( "wgNamespaceNumber" );

    // Also enable on T:TDYK and its subpages
    var ttdykPage = mw.config.get( "wgPageName" ).indexOf( "Template:Did_you_know_nominations" ) === 0;

    // Normal "read" view and not a diff view
    var normalView = mw.config.get( "wgIsArticle" ) &&
            !mw.config.get( "wgDiffOldId" );

    if( normalView && ( currNamespace % 2 === 1 || currNamespace === 4 || ttdykPage ) ) {
        loadReplyLink( jQuery, mediaWiki );
    }

    if( currNamespace === -1 && ( mw.config.get( "wgTitle" ) === "BlankPage/section-watchlist" ) ) {
        loadReplyLink( jQuery, mediaWiki, /* section-watchlist */ true );
    }
}
//</nowiki>
