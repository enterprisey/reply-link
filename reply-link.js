// vim: ts=4 sw=4 et
//<nowiki>
function loadReplyLink( $, mw ) {
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
            "rl-auto-indent": "Automatically indent?"
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
    var PARSOID_ENDPOINT = "https:" + mw.config.get( "wgServer" ) + "/api/rest_v1/page/html/";
    var HEADER_SELECTOR = "h1,h2,h3,h4,h5,h6";
    var MAX_UNICODE_DECIMAL = 1114111;
    var HEADER_REGEX = /^\s*=(=*)\s*(.+?)\s*\1=\s*$/gm;

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
        "//simple.wikipedia.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source,
        "//en.wikisource.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source,
        "//pt.wikipedia.org": /\d\dh\d\dmin\sde \d{1,2} de \w+? de \d{4}/.source
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
     * This dictionary is some global state that holds three pieces of
     * information for each "(reply)" link (keyed by their unique IDs):
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
     * talk page)
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
     * Cache for getWikitext. Only useful in test mode.
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
        console.log( "DEBUG INFORMATION: '"+currentPageName+"' @ " +
                mw.config.get( "wgCurRevisionId" ),"parsoid",PARSOID_ENDPOINT+
                encodeURIComponent(currentPageName).replace(/'/g,"%27")+"/"+mw.config.get("wgCurRevisionId") );
        throw e;
    }

    /**
     * Given some wikitext, processes it to get just the text content.
     * This function should be identical to the MediaWiki function
     * that gets the wikitext between the equal signs and comes up
     * with the id's that anchor the headers.
     */
    function wikitextToTextContent( wikitext ) {
        return decodeURIComponent( processCharEntities( wikitext ) )
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
        if( !candidates.length ) return null;
        var candidate = candidates[candidates.length-1].parentElement.parentElement;

        // Compatibility with User:Enterprisey/hover-edit-section
        // That script puts each section in its own div, so we need to
        // go out another level if it's running
        if( candidate.className === "hover-edit-section" ) {
            return candidate.parentElement;
        } else {
            return candidate;
        }
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
                rvprop: "content",
                rvslots: "main",
                rvlimit: 1,
                titles: title
            }
        ).then( function ( data ) {
            var pageId = Object.keys( data.query.pages )[0];
            if( data.query.pages[pageId].revisions ) {
                var revObj = data.query.pages[pageId].revisions[0];
                var result = { timestamp: revObj.timestamp, content: revObj.slots.main["*"] };
                getWikitextCache[ title ] = result;
                return result;
            }
            return {};
        } );
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
     *  - link: The DOM object for the link from which we got the
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

    /**
     * Ascend until dd or li, or a p directly under div.mw-parser-output.
     * live is true if we're on the live DOM (and thus we have our own UI
     * elements to deal with) and false if we're on the psd DOM.
     */
    function ascendToCommentContainer( startNode, live, recordPath ) {
        var currNode = startNode;
        if( recordPath === undefined ) recordPath = false;
        var path = [];
        var lcTag;
        var headerRegex = /h\d+/i;

        function hasHeaderAsAnyPreviousSibling( node ) {
            do {
                if( headerRegex.test( node.tagName ) ) {
                    return true;
                }
                node = node.previousElementSibling;
            } while( node );
        }

        function isActualContainer( node, nodeLcTag ) {
            if( nodeLcTag === undefined ) nodeLcTag = node.tagName.toLowerCase();
            return /dd|li/.test( nodeLcTag ) ||
                    ( ( nodeLcTag === "p" || nodeLcTag === "div" ) &&
                        ( node.parentNode.className === "mw-parser-output" ||
                            hasHeaderAsAnyPreviousSibling( node ) ||
                            node.parentNode.className === "hover-edit-section" ||
                            ( node.parentNode.tagName.toLowerCase() === "section" &&
                                node.parentNode.dataset.mwSectionId ) ) );
        }

        var smallContainerNodeLimit = live ? 3 : 1;
        do {
            currNode = currNode.parentNode;
            lcTag = currNode.tagName.toLowerCase();
            if( lcTag === "html" ) {
                console.error( "ascendToCommentContainer reached root" );
                break;
            }
            if( recordPath ) path.unshift( currNode );
            //console.log( "checking isActualContainer for ", currNode, isActualContainer( currNode, lcTag ),
            //        lcTag === "small", isActualContainer( currNode.parentNode ),
            //            currNode.parentNode.childNodes,
            //            currNode.parentNode.childNodes.length );
        } while( !isActualContainer( currNode, lcTag ) &&
            !( lcTag === "small" && isActualContainer( currNode.parentNode ) &&
                currNode.parentNode.childNodes.length <= smallContainerNodeLimit ) );
        //console.log("ascendToCommentContainer from ",startNode," terminating, r.v. ",recordPath?path:currNode);
        return recordPath ? path : currNode;
    }

    /**
     * Given a Parsoid DOM and a link in the live DOM that is the link at the
     * end of a signature, return the corresponding element in the Parsoid DOM
     * that represents the same comment, or null if none was found.
     *
     * psd = Parsoid, live = in the current, live page DOM.
     */
    function getCorrCmt( psdDom, sigLinkElem ) {

        // First, define some helper functions

        // Does this node have a timestamp in it?
        function hasTimestamp( node ) {
            //console.log ("hasTimestamp ",node, node.nodeType === 3,node.textContent.trim(),
            //            TIMESTAMP_REGEX.test( node.textContent.trim() ),
            //        node.childNodes.length === 1,
            //            node.childNodes.length && TIMESTAMP_REGEX.test( node.childNodes[0].textContent.trim()),
            //        " => ",( node.nodeType === 3 &&
            //                TIMESTAMP_REGEX.test( node.textContent.trim() ) ) ||
            //           ( node.childNodes.length === 1 &&
            //                TIMESTAMP_REGEX.test( node.childNodes[0].textContent.trim() ) ) );
            //console.log(node,node.textContent.trim(),TIMESTAMP_REGEX.test(node.textContent.trim()));
            var validTag = node.nodeType === 3 || ( node.nodeType === 1 &&
                            ( node.tagName.toLowerCase() === "small" ||
                                node.tagName.toLowerCase() === "span" ||
                                node.tagName.toLowerCase() === "p" ) );
            return ( validTag && TIMESTAMP_REGEX.test( node.textContent.trim() ) ||
                   ( node.childNodes.length === 1 &&
                        TIMESTAMP_REGEX.test( node.childNodes[0].textContent.trim() ) ) );
        }

        // Get prefix that's the actual comment
        function getPrefixComment( theNodes ) {
            var prefix = [];
            for( var j = 0; j < theNodes.length; j++ ) {
                prefix.push( theNodes[j] );
                if( hasTimestamp( theNodes[j] ) ) break;
            }
            return prefix;
        }

        /**
         * From a "container elem" (like the whole dd, li, or p that has a
         * comment), get the prefix that ends in a timestamp (because other
         * comments might be after the timestamp), and return the text content.
         */
        function surrTextContentFromElem( elem ) {
            var surrListElemNodes = elem.childNodes;

            // nodeType 8 is for comments
            return getPrefixComment( surrListElemNodes )
                    .map( function ( c ) { return ( c.nodeType !== 8 ) ? c.textContent : ""; } )
                    .join( "" ).trim();
        }

        /** From a "container elem" (dd, li, or p), remove all but the first comment. */
        function onlyFirstComment( container ) {
            //console.log("onlyFirstComment top container and container.childNodes",container,container.childNodes);
            if( container.childNodes.length === 1 && container.children[0].tagName.toLowerCase() === "small" ) {
                console.log( "[onlyFirstComment] container only had a small in it" );
                container = container.children[0];
            }
            var i, autosignedIdx, autosigned = container.querySelector( "small.autosigned" );
            if( autosigned && ( autosignedIdx = iterableToList(
                    container.childNodes ).includes( autosigned ) ) ) {
                i = autosignedIdx;
            } else {
                var childNodes = container.childNodes;
                for( i = 0; i < childNodes.length; i++ ) {
                    if( hasTimestamp( childNodes[i] ) ) {
                        //console.log( "[oFC] found a timestamp in ",childNodes[i]);
                        break;
                    }
                }
                if( i === childNodes.length ) {
                    throw new Error( "[onlyFirstComment] No timestamp found" );
                }
            }
            //console.log("[onlyFirstComment] killing all after ",i,container.childNodes[i]);
            i++;
            var elemToRemove;
            while( elemToRemove = container.childNodes[i] ) {
                container.removeChild( elemToRemove );
            }
        }

        // End helper functions, begin actual code

        // We dump this object for debugging in the event of an error
        var corrCmtDebug = {};

        // Convert live href to psd href (aka newHref)
        var newHref, liveHref = decodeURIComponent( sigLinkElem.getAttribute( "href" ) );
        corrCmtDebug.liveHref = liveHref;
        if( sigLinkElem.className.includes( "mw-selflink" ) ) {
            newHref = "./" + currentPageName;
        } else {
            if( /^\/wiki/.test( liveHref ) ) {
                var hrefTokens = liveHref.split( ":" );
                if( hrefTokens.length !== 2 ) throw new Error( "Malformed href" );
                newHref = "./" + canonicalizeNs( hrefTokens[0].replace(
                        /^\/wiki\//, "" ) ).replace( / /g, "_" ) + ":" +
                        hrefTokens[1]
                            .replace( /^Contributions%2F/, "Contributions/" )
                            .replace( /%2F/g, "/" )
                            .replace( /%23/g, "#" )
                            .replace( /%26/g, "&" )
                            .replace( /%3D/g, "=" )
                            .replace( /%2C/g, "," );
            } else {
                var REDLINK_HREF_RGX = /^\/w\/index\.php\?title=(.+?)&action=edit&redlink=1$/;
                var redlinkMatch = REDLINK_HREF_RGX.exec( liveHref );
                if( redlinkMatch ) {
                    newHref = "./" + redlinkMatch[1];
                } else {
                    newHref = liveHref.replace( /_/g, '%20' );
                }
            }
        }
        newHref = newHref.replace( /\\/g, "\\\\" )
            .replace( /'/g, "\\'" )
            .replace( /\?/g, "%3F" );
        var livePath = ascendToCommentContainer( sigLinkElem, /* live */ true, /* recordPath */ true );
        corrCmtDebug.newHref = newHref; corrCmtDebug.livePath = livePath;

        // Deal with the case where the comment has multiple links to
        // sigLinkElem's href; we will store the index of the link we want.
        // null means there aren't multiple links.
        if( liveHref ) {
            liveHref = liveHref.replace( /'/g, "\\'" );
        }
        var liveDupeLinks = livePath[0].querySelectorAll( "a" +
                ( liveHref ? ( "[href='" + liveHref + "']" ) : ".mw-selflink" ) );
        if( !liveDupeLinks ) throw new Error( "Couldn't select live dupe link" );
        var liveDupeLinkIdx = ( liveDupeLinks.length > 1 )
                ? iterableToList( liveDupeLinks ).indexOf( sigLinkElem ) : null;
        //console.log("liveDupeLinkIdx",liveDupeLinkIdx);

        //console.log("livePath[0]",livePath[0],livePath[0].childNodes);
        var liveClone = livePath[0].cloneNode( /* deep */ true );

        // Remove our own UI elements
        var ourUiSelector = ".reply-link-wrapper,#reply-link-panel";
        iterableToList( liveClone.querySelectorAll( ourUiSelector ) ).forEach( function ( n ) {
            n.parentNode.removeChild( n );
        } );

        // User:Kephir/gadgets/unclutter.js compatibility
        var unclutterContainer = liveClone.querySelector( ".kephir-unclutter-minisig" );
        if( unclutterContainer ) {

            // remove wrapping whitespace
            if( unclutterContainer.previousSibling.nodeType !== 3 ||
                    unclutterContainer.nextSibling.nodeType !== 3 ) {
                throw new Error( "unclutterContainer had non-text siblings!" );
            }
            unclutterContainer.parentNode.removeChild( unclutterContainer.previousSibling );
            unclutterContainer.parentNode.removeChild( unclutterContainer.nextSibling );

            // Move nodes from wrapper to outside the container
            var sigNodes = unclutterContainer.querySelector( ".kephir-unclutter-signature-wrapper" ).childNodes;
            var numSigNodes = sigNodes.length;
            for( var sigNodeIdx = 0; sigNodeIdx < numSigNodes; sigNodeIdx++ ) {

                // We insert the node at index 0 every time because it's a live
                // container, so as we remove nodes (via insertBefore, which
                // moves nodes and doesn't duplicate them), the node at the
                // front of sigNodes will change every time
                unclutterContainer.parentNode.insertBefore( sigNodes[0], unclutterContainer );
            }

            unclutterContainer.parentNode.removeChild( unclutterContainer );
        }

        //console.log("(BEFORE) liveClone",liveClone,liveClone.childNodes);
        onlyFirstComment( liveClone );
        //console.log("(AFTER) liveClone",liveClone,liveClone.childNodes);

        // Process it a bit to make it look a bit more like the Parsoid output
        var liveAutoNumberedLinks = liveClone.querySelectorAll( "a.external.autonumber" );
        for( var i = 0; i < liveAutoNumberedLinks.length; i++ ) {
            liveAutoNumberedLinks[i].textContent = "";
        }
        var liveSelflinks = liveClone.querySelectorAll( "a.mw-selflink.selflink" );
        for( var i = 0; i < liveSelflinks.length; i++ ) {
            liveSelflinks[i].href = "/wiki/" + currentPageName;
        }

        // "Comments in Local Time" compatibility: the text content is
        // gonna contain the modified time stamp, but the original time
        // stamp is still there
        var localCommentsSpan = liveClone.querySelector( "span.localcomments" );
        if( localCommentsSpan ) {
            var dateNode = document.createTextNode( localCommentsSpan.getAttribute( "title" ) );
            localCommentsSpan.parentNode.replaceChild( dateNode, localCommentsSpan );
        }

        // User:Writ Keeper/Scripts/teahouseTalkbackLink.js compatibility:
        // get rid of the |C|TB that it adds
        var teahouseTalkbackLink = liveClone.querySelector( "a[id^=TBsubmit]" );
        if( teahouseTalkbackLink ) {
            teahouseTalkbackLink.parentNode.removeChild( teahouseTalkbackLink.nextSibling );
            for( var ttlIdx = 0; ttlIdx < 3; ttlIdx++ ) {
                teahouseTalkbackLink.parentNode.removeChild( teahouseTalkbackLink.previousSibling );
            }
            teahouseTalkbackLink.parentNode.removeChild( teahouseTalkbackLink );
        }

        var adminMarksClass = liveClone.querySelectorAll( "b.adminMark" );
        if ( adminMarksClass.length > 0 ) {
            adminMarksClass.forEach( function ( currentValue, currentIndex, listObj ) {
                currentValue.parentNode.removeChild( currentValue );
            } );
        }
                      
        // TODO: Optimization - surrTextContentFromElem does the prefixing
        // operation a second time, even though we already called onlyFirstComment
        // on it.
        var liveTextContent = surrTextContentFromElem( liveClone );
        console.log("liveTextContent >>>>>"+liveTextContent + "<<<<<");

        function normalizeTextContent( tc ) {
            return deArmorFrenchSpaces( tc );
        }

        liveTextContent = normalizeTextContent( liveTextContent );

        // User:Kephir/gadgets/unclutter.js compatibility
        livePath = livePath.filter( function ( node ) {
            return !node.className.startsWith( "kephir" );
        } );

        var selector = livePath.map( function ( node ) {
            return node.tagName.toLowerCase();
        } ).join( " " ) + " a[href^='" + newHref + "']";

        // TODO: Optimization opportunity - run querySelectorAll only on the
        // section that we know contains the comment
        var psdLinks = iterableToList( psdDom.querySelectorAll( selector ) );
        console.log("(",liveDupeLinkIdx, ")",selector, " --> ", psdLinks);

        var oldPsdLinks = psdLinks,
            newHrefLen = newHref.length,
            hrefSubstr;
        psdLinks = [];
        for( var i = 0; i < oldPsdLinks.length; i++ ) {
            hrefSubstr = oldPsdLinks[i].getAttribute( "href" ).substring( newHrefLen );
            if( !hrefSubstr || hrefSubstr.indexOf( "#" ) === 0 ) {
                psdLinks.push( oldPsdLinks[i] );
            }
        }

        // Narrow down by entire textContent of list element
        var psdCorrLinks = []; // the corresponding link elem(s)
        if( liveDupeLinkIdx === null ) {
            for( var i = 0; i < psdLinks.length; i++ ) {
                var psdContainer = ascendToCommentContainer( psdLinks[i], /* live */ false, true );
                //console.log("psdContainer",psdContainer);
                var psdTextContent = normalizeTextContent( surrTextContentFromElem( psdContainer[0] ) );
                //console.log(i,">>>"+psdTextContent+"<<<");
                if( psdTextContent === liveTextContent ) {
                    psdCorrLinks.push( psdLinks[i] );
                } /* else {
                    //console.log(i,"len: psd live",psdTextContent.length,liveTextContent.length);
                    for(var j = 0; j < Math.min(psdTextContent.length, liveTextContent.length); j++) {
                        if(psdTextContent.charAt(j)!==liveTextContent.charAt(j)) {
                            //console.log(i,j,"psd live", psdTextContent.codePointAt(j), liveTextContent.codePointAt( j ) );
                            break;
                        }
                    }
                } */
            }
        } else {
            for( var i = 0; i < psdLinks.length; i++ ) {
                var psdContainer = ascendToCommentContainer( psdLinks[i], /* live */ false );
                if( psdContainer.dataset.replyLinkGeCorrCo ) continue;
                var psdTextContent = normalizeTextContent( surrTextContentFromElem( psdContainer ) );
                console.log(i,">>>"+psdTextContent+"<<<");
                if( psdTextContent === liveTextContent ) {
                    var psdDupeLinks = psdContainer.querySelectorAll( "a[href='" + newHref + "']" );
                    psdCorrLinks.push( psdDupeLinks[ liveDupeLinkIdx ] );
                }

                // Flag to ensure we don't take a link from this container again
                psdContainer.dataset.replyLinkGeCorrCo = true;
            }
        }

        if( psdCorrLinks.length === 0 ) {
            console.error( "Failed to find a matching comment in the Parsoid DOM." );
            return null;
        } else if( psdCorrLinks.length > 1 ) {
            console.error( "Found multiple matching comments in the Parsoid DOM." );
            return null;
        }

        return psdCorrLinks[0];
    }

    /**
     * Given a page title, the Parsoid output (GET /page/html endpoint)
     * of that page, page and a DOM object in the current page
     * corresponding to a link in a signature, locate the section
     * containing that comment. That section may not be in the provided
     * page! Returns an object with these properties:
     *
     *  - page: The full title of the page directly containing the
     *    comment (in its wikitext, not through transclusion).
     *  - sectionName: The anticipated wikitext section name. Should
     *    appear inside the equal signs at the above index.
     *  - sectionDupeIdx: If there are multiple sections with the same
     *    name, the 0-based index of the section with the comment among
     *    those sections. Otherwise, 0.
     *  - sectionLevel: The anticipated wikitext section level (e.g.
     *    2 for an h2)
     *  - nearbyMwId: The Parsoid ID of some element near the
     *    comment (in practice, a userspace link) for jumping purposes.
     *
     * Parsoid is abbreviated here as "psd" in variables and comments.
     */
    function findSection( psdDomPageTitle, psdDomString, sigLinkElem ) {
        console.log("findSection(",psdDomPageTitle,", ...)");

        //console.log(psdDomString);

        var domParser = new DOMParser(),
            psdDom = domParser.parseFromString( psdDomString, "text/html" );

        var corrLink = getCorrCmt( psdDom, sigLinkElem );
        if( corrLink === null ) {
            console.error( "corrLink === null" );
            return $.when();
        }
        //console.log("STEP 1 SUCCESS",corrLink);

        var corrCmt = ascendToCommentContainer( corrLink, /* live */ false );

        // Ascend until we hit something in a transclusion
        var currNode = corrLink;
        var tsclnId = null;
        do {
            if( currNode.getAttribute( "about" ) &&
                    currNode.getAttribute( "about" ).indexOf( "#mwt" ) === 0 ) {
                tsclnId = currNode.getAttribute( "about" );
                break;
            }
            currNode = currNode.parentNode;
        } while( currNode.tagName.toLowerCase() !== "html" );
        //console.log( "tsclnId", tsclnId );

        // Helper function: are we in a pseudo-section? (Unused, at the moment.)
        function inPseudo( headerElement ) {
            var currNodeIP = headerElement;
            // This requires Parsoid HTML v 2.0.0
            do {
                if( currNodeIP.nodeType === 1 && currNodeIP.matches( "section" ) ) {
                    return currNodeIP.dataset.mwSectionId < 0;
                    break;
                }
                currNodeIP = currNodeIP.parentNode;
            } while( currNodeIP );
            return false;
        }

        // Now, get the nearest header above us
        var currNode = corrCmt;
        var nearestHeader = null;
        var HTML_HEADER_RGX = /^h\d$/;
        do {
            if( HTML_HEADER_RGX.exec( currNode.tagName.toLowerCase() ) ) {
                // Commented because I don't think the !inPseudo requirement is necessary 2019-nov-01
                //if( !inPseudo( currNode ) ) {
                    nearestHeader = currNode;
                    break;
                //}
            }
            var containedHeaders = currNode.querySelectorAll( HEADER_SELECTOR );
            if( containedHeaders.length ) {
                var nearestHdrIdx = containedHeaders.length - 1;
                // Commented because I don't think the !inPseudo requirement is necessary 2019-nov-01

                // TODO this is an extraordinarily silly while loop; it has been temporarily commented 2020-apr-25
                //while( nearestHdrIdx >= 0 ){//&& inPseudo( containedHeaders[ nearestHdrIdx ] ) ) 
                //    nearestHdrIdx--;
                //}
                if( nearestHdrIdx >= 0 ) {
                    nearestHeader = containedHeaders[ nearestHdrIdx ];
                    break;
                }
            }
            if( currNode.previousElementSibling ) {
                currNode = currNode.previousElementSibling;
                continue;
            }
            currNode = currNode.parentNode;
        } while( currNode.tagName.toLowerCase() !== "body" );

        // Get the target page (page actually containing the comment)
        var targetPage;
        if( tsclnId === null ) {
            console.warn( "tsclnId === null" );
            targetPage = psdDomPageTitle;
        } else {
            var tsclnInfoSel = "*[about='" + tsclnId + "'][typeof='mw:Transclusion']",
                infoJson = JSON.parse( psdDom.querySelector( tsclnInfoSel ) .dataset.mw );

            // First, check the first and last wikitext segments to see if they have the header
            var firstWktxtSegIdx = 0;
            while( infoJson.parts[firstWktxtSegIdx].template &&
                infoJson.parts[firstWktxtSegIdx].template.target.href.startsWith( "Template:" ) &&
                firstWktxtSegIdx < infoJson.parts.length ) {
                firstWktxtSegIdx++;
            }
            if( firstWktxtSegIdx < infoJson.parts.length && typeof infoJson.parts[firstWktxtSegIdx] === typeof '' ) {
                var firstWktxtSeg = infoJson.parts[firstWktxtSegIdx];
                var headerMatch = null;
                do {
                    headerMatch = HEADER_REGEX.exec( firstWktxtSeg );
                    if( headerMatch ) {
                        if( wikitextHeaderEqualsDomHeader( headerMatch[2], nearestHeader.textContent ) ) {
                            targetPage = psdDomPageTitle;
                            break;
                        }
                    }
                } while( headerMatch );
            }
        }

        if( !targetPage ) {
            var lastWktxtSegIdx = infoJson.parts.length - 1;
            while( infoJson.parts[lastWktxtSegIdx].template &&
                infoJson.parts[lastWktxtSegIdx].template.target.href.startsWith( "Template:" ) &&
                lastWktxtSegIdx >= 0 ) {
                lastWktxtSegIdx--;
            }
            if( lastWktxtSegIdx >= 0 && typeof infoJson.parts[lastWktxtSegIdx] === typeof '' ) {
                var lastWktxtSeg = infoJson.parts[lastWktxtSegIdx];
                var headerMatch = null;
                do {
                    headerMatch = HEADER_REGEX.exec( lastWktxtSeg );
                    if( headerMatch ) {
                        if( wikitextHeaderEqualsDomHeader( headerMatch[2], nearestHeader.textContent ) ) {
                            targetPage = psdDomPageTitle;
                            break;
                        }
                    }
                } while( headerMatch );
            }
        }

        var recursiveCalls = $.when();
        if( !targetPage ) {
            // Recurse on all non-top-level Templates!

            var pages = infoJson.parts.filter( function ( part ) {
                return part.template &&
                    part.template.target &&
                    part.template.target.href && (
                        !part.template.target.href.startsWith("./Template") ||
                        ( part.template.target.href.match( new RegExp( '/', 'g' ) ) || [] ).length >= 2
                    );
            } );
            if( pages.length ) {
                var pageNames = pages.map( function ( part ) {
                    return part.template.target.href.substring( 2 ); // remove the ./
                } );
                var deferreds = pageNames.map( function ( pageName ) {
                    return $.get( PARSOID_ENDPOINT + encodeURIComponent( pageName ) )
                        .then( function ( data ) { return data; } ); // truncate to first argument, which is the data
                } );
                recursiveCalls = $.when.apply( $, deferreds ).then( function () {
                    var results = arguments; // use keyword "arguments" to access deferred results
                    var deferreds2 = [];
                    if( pageNames.length !== results.length ) {
                        console.error(pageNames,results);
                        throw new Error( "pageNames.length !== results.length: " + pageNames.length + " " + results.length );
                    }
                    for( var i = 0; i < pageNames.length; i++ ) {
                        deferreds2.push( findSection( pageNames[i], results[i], sigLinkElem ) );
                    }
                    return $.when.apply( $, deferreds2 ).then( function () {
                        var results2 = Array.prototype.slice.call( arguments );
                        var namesAndResults2 = [];
                        if( pageNames.length !== results2.length ) {
                            throw new Error( "pageNames.length !== results2.length: " + pageNames.length + " " + results2.length );
                        }
                        for( var i = 0; i < pageNames.length; i++ ) {
                            if( results2[i] ) {
                                namesAndResults2.push( [ pageNames[i], results2[i] ] );
                            }
                        }
                        if( namesAndResults2.length === 0 ) {
                            return null;
                        } else if( namesAndResults2.length === 1 ) {
                            return namesAndResults2[0][1];
                        } else {
                            var allSameName = namesAndResults2.every( function ( nameAndResult ) {
                                return nameAndResult[0] === namesAndResults2[0][0];
                            } );
                            if( allSameName ) {
                                return namesAndResults2[0][1];
                            } else {
                                console.error( "WTF", namesAndResults2 );
                            }
                        }
                    } );
                } );
            }
        }

        return recursiveCalls.then( function ( data ) {
            if( data ) {
                return data;
            } else if( nearestHeader === null ) {
                return {
                    page: targetPage,
                    sectionName: "",
                    sectionDupeIdx: 0,
                    sectionLevel: 0,
                    nearbyMwId: corrCmt.id
                };
            } else {

                // We tried recursing, and it didn't work, so the
                // section must be on the current page
                targetPage = psdDomPageTitle;

                // Finally, get the index of our nearest header
                var allHeaders = iterableToList( psdDom.querySelectorAll( HEADER_SELECTOR ) );

                var sectionDupeIdx = 0;
                for( var i = 0; i < allHeaders.length; i++ ) {
                    if( allHeaders[i].textContent === nearestHeader.textContent ) {
                        if( allHeaders[i] === nearestHeader ) {
                            break;
                        } else {
                            sectionDupeIdx++;
                        }
                    }
                }

                var result = {
                    page: targetPage,
                    sectionName: nearestHeader.textContent,
                    sectionDupeIdx: sectionDupeIdx,
                    sectionLevel: nearestHeader.tagName.substring( 1 ), // that is, cut off the "h" at the beginning
                    nearbyMwId: corrCmt.id
                };
                //console.log("findSection return val: ",result);
                return result;
            }
        } );
    }

    /**
     * Given some wikitext that's split into sections, return the full
     * wikitext (including header and newlines until the next header) of
     * the section with the given name. To get the content before the
     * first header, sectionName should be "".
     *
     * Performs a sanity check with the given section name.
     */
    function getSectionWikitext( wikitext, sectionName, sectionDupeIdx ) {
        console.log("In getSectionWikitext, sectionName = >" + sectionName + "< (wikitext.length = " + wikitext.length + ")");
        //console.log("wikitext (first 1000 chars) is " + dirtyWikitext.substring(0, 1000));

        // There are certain locations where a header may appear in the
        // wikitext, but will not be present in the HTML; such as code
        // blocks or comments. So we keep track of those ranges
        // and ignore headings inside those.
        var ignoreSpanStarts = []; // list of ignored span beginnings
        var ignoreSpanLengths = []; // list of ignored span lengths
        var IGNORE_RE = /(<pre>[\s\S]+?<\/pre>)|(<source.+?>[\s\S]+?<\/source>)|(<!--[\s\S]+?-->)/g;
        var ignoreSpanMatch;
        do {
            ignoreSpanMatch = IGNORE_RE.exec( wikitext );
            if( ignoreSpanMatch ) {
                //console.log("ignoreSpan ",ignoreSpanStarts.length," = ",ignoreSpanMatch);
                ignoreSpanStarts.push( ignoreSpanMatch.index );
                ignoreSpanLengths.push( ignoreSpanMatch[0].length );
            }
        } while( ignoreSpanMatch );

        var startIdx = -1; // wikitext index of section start
        var endIdx = -1; // wikitext index of section end

        var headerCounter = 0;
        var headerMatch;

        // So that we don't check every ignore span every time
        var ignoreSpanStartIdx = 0;

        var dupeCount = 0;
        var lookingForEnd = false;

        if( sectionName === "" ) {
            // Getting first section
            startIdx = 0;
            lookingForEnd = true;
        }

        // Reset regex state, if for some reason we're not running this for the first time
        HEADER_REGEX.lastIndex = 0;

        headerMatchLoop:
        do {
            headerMatch = HEADER_REGEX.exec( wikitext );
            if( headerMatch ) {

                // Check that we're not inside one of the "ignore" spans
                for( var igIdx = ignoreSpanStartIdx; igIdx <
                    ignoreSpanStarts.length; igIdx++ ) {
                    if( headerMatch.index > ignoreSpanStarts[igIdx] ) {
                        if ( headerMatch.index + headerMatch[0].length <=
                            ignoreSpanStarts[igIdx] + ignoreSpanLengths[igIdx] ) {

                            console.log("(IGNORED, igIdx="+igIdx+") Header " + headerCounter + " (idx " + headerMatch.index + "): >" + headerMatch[0].trim() + "<");

                            // Invalid header
                            continue headerMatchLoop;
                        } else {

                            // We'll never encounter this span again, since
                            // headers only get later and later in the wikitext
                            ignoreSpanStartIdx = igIdx;
                        }
                    }
                }

                //console.log("Header " + headerCounter + " (idx " + headerMatch.index + "): >" + headerMatch[0].trim() + "<");
                // Note that if the lookingForEnd block were second,
                // then two consecutive matching section headers might
                // result in the wrong section being matched!
                if( lookingForEnd ) {
                    endIdx = headerMatch.index;
                    break;
                } else if( wikitextHeaderEqualsDomHeader( /* wikitext */ headerMatch[2], /* dom */ sectionName ) ) {
                    if( dupeCount === sectionDupeIdx ) {
                        startIdx = headerMatch.index;
                        lookingForEnd = true;
                    } else {
                        dupeCount++;
                    }
                }
            }
            headerCounter++;
        } while( headerMatch );

        if( startIdx < 0 ) {
            throw( "Could not find section named \"" + sectionName + "\" (dupe idx " + sectionDupeIdx + ")" );
        }

        // If we encountered no section after the target section,
        // then the target was the last one and the slice will go
        // until the end of wikitext
        if( endIdx < 0 ) {
            //console.log("[getSectionWikitext] endIdx negative, setting to " + wikitext.length);
            endIdx = wikitext.length;
        }

        //console.log("[getSectionWikitext] Slicing from " + startIdx + " to " + endIdx);
        return wikitext.slice( startIdx, endIdx );
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
                console.error("[sigIdxToStrIdx] out of matches");
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
     * cmtAuthorDom is the username of the person who wrote the comment
     * we're replying to, parsed from the DOM. revObj is the object returned
     * by getWikitext for the page with the comment; findSectionResult is the
     * object returned by findSection for the comment.
     *
     * Returns a Deferred that resolves/rejects when the reply succeeds/fails.
     */
    function doReply( indentation, header, sigIdx, cmtAuthorDom, rplyToXfdNom, revObj, findSectionResult ) {
        console.log("TOP OF doReply",header,findSectionResult);
        header = [ "" + findSectionResult.sectionLevel, findSectionResult.sectionName, findSectionResult.sectionDupeIdx ];
        var deferred = $.Deferred();

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
                    replyLines[0] = "{" + "{od|" + indentation.slice( 0, -1 ) +
                        "}}" + replyLines[0];
                    indentation = "";
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
                            return indentation + "*" + line;
                        } ).join( "\n" );
                    } else {
                        fullReply = indentation + "* " + replyLines.join( "{{pb}}" );
                    }
                } else {
                    fullReply = replyLines.map( function ( line ) {
                        return indentation + ":" + line;
                    } ).join( "\n" );
                }
            } else {
                fullReply = reply;
            }

            // Prepare section metadata for getSectionWikitext call
            console.log( "in doReply, header =", header );
            var sectionHeader, sectionIdx;
            if( header === null ) {
                sectionHeader = null, sectionIdx = -1;
            } else {
                sectionHeader = header[1], sectionDupeIdx = header[2];
            }

            // Compatibility with User:Bility/copySectionLink
            if( document.querySelector( "span.mw-headline a#sectiontitlecopy0" ) ) {

                // If copySectionLink is active, the paragraph symbol at
                // the end is a fake
                sectionHeader = sectionHeader.replace( /\s*¶$/, "" );
            }

            // Compatibility with the "auto-number headings" preference
            if( document.querySelector( "span.mw-headline-number" ) ) {
                sectionHeader = sectionHeader.replace( /^\d+ /, "" );
            }

            var sectionWikitext = getSectionWikitext( wikitext, sectionHeader, sectionDupeIdx );
            var oldSectionWikitext = sectionWikitext; // We'll String.replace old w/ new

            // Now, obtain the index of the end of the comment
            var strIdx = sigIdxToStrIdx( sectionWikitext, sigIdx );

            // Check for a non-negative strIdx
            if( strIdx < 0 ) {
                throw( "Negative strIdx (signature not found in wikitext)" );
            }

            // Determine the user who wrote the comment, for
            // edit-summary and sanity-check purposes
            var userRgx = new RegExp( /\[\[\s*(?:m:)?:?\s*/.source + userspcLinkRgx.both + /\s*(.+?)(?:\/.+?)?(?:#.+?)?\s*(?:\|.+?)?\]\]/.source, "ig" );
            var userMatches = processCharEntitiesWikitext( sectionWikitext.slice( 0, strIdx ) ).match( userRgx );
            var cmtAuthorWktxt = userRgx.exec(
                    userMatches[userMatches.length - 1] )[1];

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
            cmtAuthorDom = sanitizeUsername( cmtAuthorDom );

            // Do a sanity check: is the sig username the same as the
            // DOM one?  We attempt to check sigRedirectMapping in case
            // the naive check fails
            if( cmtAuthorWktxt !== cmtAuthorDom &&
                    processCharEntitiesWikitext( cmtAuthorWktxt ) !== cmtAuthorDom &&
                    sigRedirectMapping[ cmtAuthorWktxt ] !== cmtAuthorDom ) {
                throw new Error( "Sanity check on sig username failed! Found " +
                    cmtAuthorWktxt + " but expected " + cmtAuthorDom +
                    " (wikitext vs DOM)" );
            }

            // Actually insert our reply into the section wikitext
            sectionWikitext = insertTextAfterIdx( sectionWikitext, strIdx,
                    indentation.length, fullReply );

            // Also, if the user wanted the edit request to be answered,
            // do that
            var editReqCheckbox = document.getElementById(  "reply-link-option-edit-req" );
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

            var newWikitext = wikitext.replace( oldSectionWikitext,
                    sectionWikitext );

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
            var summary = "/* " + sectionHeader + " */ " + summaryCore + mw.msg( "rl-advert" );

            // Send another request, this time to actually edit the
            // page
            api.postWithToken( "csrf", {
                action: "edit",
                title: findSectionResult.page,
                summary: summary,
                text: newWikitext,
                basetimestamp: revObj.timestamp
            } ).done ( function ( data ) {

                // We put this function on the window object because we
                // give the user a "reload" link, and it'll trigger the function
                window.replyLinkReload = function () {
                    window.location.hash = sectionHeader.replace( / /g, "_" );
                    if( findSectionResult.nearbyMwId ) {
                        document.cookie = "parsoid_jump=" + findSectionResult.nearbyMwId;
                    }
                    window.location.reload( true );
                };
                if ( data && data.edit && data.edit.result && data.edit.result == "Success" ) {
                    var needPurge = findSectionResult.page !== currentPageName;

                    function finishReply( _ ) {
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
                setStatus( "While replying, the edit failed." );
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


    function handleWrapperClick ( linkLabel, parent, rplyToXfdNom ) {
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

                // Fetch metadata about this specific comment
                var ourMetadata = metadata[this.id];

                // If the dry-run option is "checkbox", add an option to make it
                // a dry run
                if( window.replyLinkDryRun === "checkbox" ) {
                    newOption( "reply-link-option-dry-run", "Don't actually edit?", true );
                }

                // If the current section header text indicates an edit request,
                // offer to mark it as answered
                if( ourMetadata[1] && EDIT_REQ_REGEX.test( ourMetadata[1][1] ) ) {
                    newOption( "reply-link-option-edit-req", "Mark edit request as answered?", false );
                }

                // If the previous comment was indented by OUTDENT_THRESH,
                // offer to outdent
                if( ourMetadata[0].length >= OUTDENT_THRESH ) {
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

                // Called by the "Reply" button, Ctrl-Enter in the text area, and
                // Enter/Ctrl-Enter in the summary field
                function startReply() {

                    // Change UI to make it clear we're performing an operation
                    document.getElementById( "reply-dialog-field" ).style["background-image"] =
                        "url(" + window.replyLinkPendingImageUrl + ")";
                    document.querySelector( "#reply-link-buttons button" ).disabled = true;
                    setStatus( mw.msg( "rl-loading" ) );

                    var parsoidUrl = PARSOID_ENDPOINT + encodeURIComponent( currentPageName ) +
                            "/" + mw.config.get( "wgCurRevisionId" ),
                        findSectionResultPromise = $.get( parsoidUrl )
                            .then( function ( parsoidDomString ) {
                                return findSection( currentPageName, parsoidDomString, cmtLink );
                        },console.error );

                    var revObjPromise = findSectionResultPromise.then( function ( findSectionResult ) {
                        console.log( "findSectionResult ", findSectionResult );
                        return getWikitext( findSectionResult.page );
                    },console.error );

                    $.when( findSectionResultPromise, revObjPromise ).then( function ( findSectionResult, revObj ) {
                        // ourMetadata contains data in the format:
                        // [indentation, header, sigIdx]
                        doReply( ourMetadata[0], ourMetadata[1], ourMetadata[2],
                            cmtAuthor, rplyToXfdNom, revObj, findSectionResult );
                    }, function (e) { setStatusError(new Error(e))} );
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
                        $.post( "https:" + mw.config.get( "wgServer" ) +
                            "/w/api.php?action=parse&format=json&title=" + currentPageName + "&text=" + sanitizedCode
                                + "&pst=1",
                            function ( res ) {
                                if ( !res || !res.parse || !res.parse.text ) return console.log( "Preview failed" );
                                document.getElementById( "reply-link-preview" ).innerHTML = res.parse.text['*'];
                                // Add target="_blank" to links to make them open in a new tab by default
                                var links = document.querySelectorAll( "#reply-link-preview a" );
                                for( var i = 0, n = links.length; i < n; i++ ) {
                                    links[i].setAttribute( "target", "_blank" );
                                }
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
    function attachLinkAfterNode( node, preferredId, anyIndentation ) {

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
        var linkLabel = mw.msg( "rl-reply-label" ) + ( rplyToXfdNom ? mw.msg( "rl-to-label" ) + xfdType : "" );

        // Construct new link
        var newLinkWrapper = document.createElement( "span" );
        newLinkWrapper.className = "reply-link-wrapper";
        var newLink = document.createElement( "a" );
        newLink.href = "#";
        newLink.id = preferredId;
        newLink.dataset.originalLabel = linkLabel;
        newLink.appendChild( document.createTextNode( linkLabel ) );
        newLink.addEventListener( "click", handleWrapperClick( linkLabel, parent, rplyToXfdNom ) );
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
                    attachLinkAfterNode( node, linkId, !!currIndentation );
                    idNum++;

                    // Update global metadata dictionary
                    metadata[linkId] = currIndentation;
                }
            } else if( node.nodeType === 1 &&
                    /^(div|p|dl|dd|ul|li|span|ol|table|tbody|tr|td)$/.test( node.tagName.toLowerCase() ) ) {
                switch( node.tagName.toLowerCase() ) {
                    case "dl": newIndentSymbol = ":"; break;
                    case "ul": newIndentSymbol = "*"; break;
                    case "ol": newIndentSymbol = "#"; break;
                    case "div":
                        if( node.className.includes( "xfd_relist" ) ) {
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

        // This loop adds two entries in the metadata dictionary:
        // the header data, and the sigIdx values
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

                // Dig down one level for the header text because
                // MW buries the text in a span inside the header
                var headlineEl = null;
                if( currHeaderEl.childNodes[0].className &&
                    currHeaderEl.childNodes[0].className.includes( "mw-headline" ) ) {
                    headlineEl = currHeaderEl.childNodes[0];
                } else {
                    for( var i = 0; i < currHeaderEl.childNodes.length; i++ ) {
                        if( currHeaderEl.childNodes[i].className &&
                                currHeaderEl.childNodes[i].className.includes( "mw-headline" ) ) {
                            headlineEl = currHeaderEl.childNodes[i];
                            break;
                        }
                    }
                }

                var headerName = null;
                if( headlineEl ) {
                    headerName = headlineEl.textContent;
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
                    currHeaderData ? currHeaderData.slice(0) : null,
                    currSigIdx ];
                currSigIdx++;
            }
        }
        //console.log(metadata);

        // Disable links inside hatnotes, archived discussions
        var badRegionsSelector = "div.archived,div.resolved,table";
        var badRegions = mainContent.querySelectorAll( badRegionsSelector );
        for( var i = 0; i < badRegions.length; i++ ) {
            var badRegion = badRegions[i];
            var insideArchived = badRegion.querySelectorAll( ".reply-link-wrapper" );
            console.log(insideArchived);
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

        // Fetch content, Parsoid DOM, etc
        var parsoidUrl = PARSOID_ENDPOINT + encodeURIComponent( currentPageName );
        $.when(
            $.get( parsoidUrl ),
            api.loadMessages( INT_MSG_KEYS )
        ).then( function ( parsoidDomString, _ ) {
            buildUserspcLinkRgx();

            // Statistics variables
            var successes = 0, failures = 0;

            // Run one test on a wrapper link
            function runOneTestOn( wrapper ) {
                try {
                    var cmtAuthorAndLink = getCommentAuthor( wrapper ),
                        cmtAuthor = cmtAuthorAndLink.username,
                        cmtLink = cmtAuthorAndLink.link;
                    var ourMetadata = metadata[ wrapper.children[0].id ];
                    findSection( currentPageName, parsoidDomString, cmtLink ).then( function ( findSectionResult ) {
                        var revObjPromise = getWikitext( findSectionResult.page, /* useCaching */ true );
                        $.when( findSectionResult, revObjPromise ).then( function ( findSectionResult, revObj ) {
                                doReply( ourMetadata[0], ourMetadata[1], ourMetadata[2],
                                        cmtAuthor, false, revObj, findSectionResult ).done( function () {
                                            wrapper.style.background = "green";
                                            successes++;
                                        } ).fail( function () {
                                            wrapper.style.background = "red";
                                            failures++;
                                        } );
                        }, function ( e ) {
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
                    setTimeout( runOneTest, 750 );
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
        if( window.replyLinkAutoReload === undefined ) window.replyLinkAutoReload = true;
        if( window.replyLinkDryRun === undefined ) window.replyLinkDryRun = "never";
        if( window.replyLinkPreloadPing === undefined ) window.replyLinkPreloadPing = "always";
        if( window.replyLinkPreloadPingTpl === undefined ) window.replyLinkPreloadPingTpl = "{{u|##}}, ";
        if( window.replyLinkCustomSummary === undefined ) window.replyLinkCustomSummary = false;
        if( window.replyLinkTestMode === undefined ) window.replyLinkTestMode = false;
        if( window.replyLinkTestInstantReply === undefined) window.replyLinkTestInstantReply = false;
        if( window.replyLinkAutoIndentation === undefined ) window.replyLinkAutoIndentation = "checkbox";

        // Insert "reply" links into DOM
        attachLinks();

        // If test mode is enabled, create a link for that
        if( window.replyLinkTestMode ) {
            mw.util.addPortletLink( "p-cactions", "#", "reply-link test mode", "pt-reply-link-test" )
                .addEventListener( "click", runTestMode );
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
    }

    mw.loader.load( "mediawiki.ui.input", "text/css" );
    mw.loader.using( [ "mediawiki.util", "mediawiki.api" ] ).then( function () {
        mw.hook( "wikipage.content" ).add( onReady );
    } );

    $.getScript('https://en.wikipedia.org/w/index.php?title=User:Enterprisey/parsoid-jump.js&action=raw&ctype=text%2Fjavascript');

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

    if ( normalView && ( currNamespace % 2 === 1 || currNamespace === 4 || ttdykPage ) ) {
        loadReplyLink( jQuery, mediaWiki );
    }
}
//</nowiki>

