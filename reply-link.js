// vim: ts=4 sw=4 et
//<nowiki>
function loadReplyLink( $, mw ) {
    var TIMESTAMP_REGEX = /\(UTC(?:(?:−|\+)\d+?(?:\.\d+)?)?\)\S*?\s*$/m;
    var EDIT_REQ_REGEX = /^((Semi|Template|Extended-confirmed)-p|P)rotected edit request on \d\d? \w+ \d{4}/;
    var EDIT_REQ_TPL_REGEX = /\{\{edit (template|fully|extended|semi)-protected\s*(\|.+?)*\}\}/;
    var LITERAL_SIGNATURE = "~~" + "~~"; // split up because it might get processed
    var ADVERT = " ([[w:en:User:Enterprisey/reply-link|reply-link]])";
    var PARSOID_ENDPOINT = "https:" + mw.config.get( "wgServer" ) + "/api/rest_v1/page/html/";
    var HEADER_SELECTOR = "h1,h2,h3,h4,h5,h6";

    // T:TDYK, used at the end of loadReplyLink
    var TTDYK = "Template:Did_you_know_nominations";

    // Threshold for indentation when we offer to outdent
    var OUTDENT_THRESH = 8;

    // All of the interface message keys that we explicitly load
    var INT_MSG_KEYS = [ "mycontris" ];

    // Date format regexes in signatures (i.e. the "default date format")
    var DATE_FMT_RGX = {
        "//en.wikipedia.org": /\d\d:\d\d,\s\d{1,2}\s\w+?\s\d{4}/.source,
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
        return text.replace( /\xA0([?:;!%»›])/g, " $1" );
    }

    /**
     * Capitalize the first letter of a string.
     */
    function capFirstLetter( someString ) {
        return someString.charAt( 0 ).toUpperCase() + someString.slice( 1 );
    }

    /**
     * Canonical-ize a namespace.
     */
    function canonicalizeNs( ns ) {
        return fmtNs( mw.config.get( "wgNamespaceIds" )[ ns.toLowerCase().replace( / /g, "_" ) ] );
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
     * Decode HTML entities. Used in the signature sanity check.
     * Source: https://stackoverflow.com/a/1912522/1757964
     */
    function htmlDecode( html ) {
        var el = document.createElement( "span" );
        el.innerHTML = html;
        return el.childNodes[0].nodeValue;
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
        setStatus( "There was an error while replying! Please leave a note at " +
            "<a href='https://en.wikipedia.org/wiki/User_talk:Enterprisey/reply-link'>the script's talk page</a>" +
            " with any errors in <a href='https://en.wikipedia.org/wiki/WP:JSERROR'>the browser console</a>, if possible." );
        if( e.message ) {
            console.log( "Content request error: " + JSON.stringify( e.message ) );
        }
        throw e;
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
     * Given some wikitext, processes it to get just the text content.
     * This function should be identical to the MediaWiki function
     * that gets the wikitext between the equal signs and comes up
     * with the id's that anchor the headers.
     */
    function wikitextToTextContent( wikitext ) {
        return decodeURIComponent( processCharEntities( wikitext ) )
            .replace( /\[\[:?(?:[^\|]+?\|)?([^\]\|]+?)\]\]/g, "$1" )
            .replace( /\{\{\s*tl\s*\|\s*(.+?)\s*\}\}/g, "{{$1}}" )
            .replace( /\{\{\s*[Uu]\s*\|\s*(.+?)\s*\}\}/g, "$1" )
            .replace( /('''?)(.+?)\1/g, "$2" )
            .replace( /<span.*?>(.*?)<\/span>/g, "$1" );
    }

    /**
     * Finds and returns the div that is the immediate parent of the
     * first talk page header on the page, so that we can read all the
     * sections by iterating through its child nodes.
     */
    function findMainContentEl() {

        // Which header are we looking for?
        var targetHeader = "h2";
        if( xfdType ) targetHeader = "h3";
        if( currentPageName.startsWith( TTDYK ) ) targetHeader = "h4";

        // The element itself will be the text span in the h2; its
        // parent will be the h2; and the parent of the h2 is the
        // content container that we want
        var candidate = document.querySelector( targetHeader + " > span.mw-headline" )
            .parentElement
            .parentElement;

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
        userspcLinkRgx.both = "(?:" + userspcLinkRgx.spc + "|" + userspcLinkRgx.und + ")";
    }

    /**
     * Is there a signature (four tildes) present in the given text,
     * outside of a nowiki element?
     */
    function hasSig( text ) {

        // no literal signature?
        if( text.indexOf( LITERAL_SIGNATURE ) < 0 ) return false;

        // if there's a literal signature and no nowiki elements,
        // there must be a real signature
        if( text.indexOf( "<nowiki>" ) < 0 ) return true;

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
            console.log(i,"top of outer for in findUsernameInElem ",el, " links -> ",links);

            // Compatibility with "Comments in Local Time"
            if( el.className.indexOf( "localcomments" ) >= 0 ) i--;

            // If we couldn't get any links, try again with prev elem
            if( !links ) continue;

            var link; // his name isn't zelda
            for( var j = 0; j < links.length; j++ ) {
                link = links[j];

                console.log(link,decodeURIComponent(link.getAttribute("href")));
                if( link.className.indexOf( "mw-selflink" ) >= 0 ) {
                    return { username: currentPageName.replace( /.+:/, "" )
                        .replace( /_/g, " " ), link: link };
                }

                // Also matches redlinks. Why people have redlinks in their sigs on
                // purpose, I may never know.
                //console.log( "^\\/(?:wiki\\/" + userspcLinkRgx.und + /(.+?)(?:\/.+?)?(?:#.+)?|w\/index\.php\?title=User(?:_talk)?:(.+?)&action=edit&redlink=1/.source + ")$" )
                var sigLinkRe = new RegExp( "^\\/(?:wiki\\/" + userspcLinkRgx.und + /(.+?)(?:\/.+?)?(?:#.+)?|w\/index\.php\?title=/.source + userspcLinkRgx.und + /(.+?)&action=edit&redlink=1/.source + ")$" );
                var usernameMatch = sigLinkRe.exec( decodeURIComponent( link.getAttribute( "href" ) ) );
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
        console.log(sigNode,sigNode.style,sigNode.style ? sigNode.style.getPropertyValue("size"):"");
        var smallOrFake = sigNode.nodeType === 1 &&
                ( sigNode.tagName.toLowerCase() === "small" ||
                ( sigNode.tagName.toLowerCase() === "span" &&
                    sigNode.style && sigNode.style.getPropertyValue( "font-size" ) === "85%" ) );

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
        function isActualContainer( node, nodeLcTag ) {
            if( nodeLcTag === undefined ) nodeLcTag = node.tagName.toLowerCase();
            return /dd|li/.test( nodeLcTag ) ||
                    ( nodeLcTag === "p" &&
                        ( node.parentNode.className === "mw-parser-output" ||
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
     * that represents the same comment.
     *
     * psd = Parsoid, live = in the current, live page DOM.
     */
    function getCorrCmt( psdDom, sigLinkElem ) {
        
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
                                node.tagName.toLowerCase() === "span" ) );
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
            console.log("onlyFirstComment top container and container.childNodes",container,container.childNodes);
            if( container.children.length === 1 && container.children[0].tagName.toLowerCase() === "small" ) {
                console.log( "[onlyFirstComment] container only had a small in it" );
                container = container.children[0];
            }
            var i, autosignedIdx, autosigned = container.querySelector( "small.autosigned" );
            if( autosigned && ( autosignedIdx = iterableToList(
                    container.childNodes ).indexOf( autosigned ) ) >= 0 ) {
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

        // Convert live href to psd href
        var newHref, liveHref = decodeURIComponent( sigLinkElem.getAttribute( "href" ) );
        if( sigLinkElem.className.indexOf( "mw-selflink" ) >= 0 ) {
            newHref = "./" + currentPageName; 
        } else {
            if( /^\/wiki/.test( liveHref ) ) {
                var hrefTokens = liveHref.split( ":" );
                if( hrefTokens.length !== 2 ) throw new Error( "Malformed href" );
                newHref = "./" + canonicalizeNs( hrefTokens[0].replace(
                        /^\/wiki\//, "" ) ).replace( / /g, "_" ) + ":" +
                        encodeURIComponent( hrefTokens[1] )
                            .replace( /^Contributions%2F/, "Contributions/" )
                            .replace( /%23/g, "#" );
            } else {
                var REDLINK_HREF_RGX = /^\/w\/index\.php\?title=(.+?)&action=edit&redlink=1$/;
                newHref = "./" + REDLINK_HREF_RGX.exec( liveHref )[1];
            }
        }
        var livePath = ascendToCommentContainer( sigLinkElem, /* live */ true, /* recordPath */ true );
        //console.log("livePath",livePath)

        // Deal with the case where the comment has multiple links to
        // sigLinkElem's href; we will store the index of the link we want.
        // null means there aren't multiple links.
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

        //console.log("liveClone",liveClone,liveClone.childNodes);
        onlyFirstComment( liveClone );
        //console.log("liveClone.childNodes",liveClone.childNodes);

        // Process it a bit to make it look a bit more like the Parsoid output
        var liveAutoNumberedLinks = liveClone.querySelectorAll( "a.external.autonumber" );
        for( var i = 0; i < liveAutoNumberedLinks.length; i++ ) {
            liveAutoNumberedLinks[i].textContent = "";
        }
        var liveSelflinks = liveClone.querySelectorAll( "a.mw-selflink.selflink" );
        for( var i = 0; i < liveSelflinks.length; i++ ) {
            liveSelflinks[i].href = "/wiki/" + currentPageName;
        }

        // TODO: Optimization - surrTextContentFromElem does the prefixing
        // operation a second time, even though we already called onlyFirstComment
        // on it.
        var liveTextContent = surrTextContentFromElem( liveClone );
        //console.log("liveTextContent",liveTextContent);

        var selector = livePath.map( function ( node ) {
            return node.tagName.toLowerCase();
        } ).join( " " ) + " a[href='" + newHref + "']";

        // TODO: Optimization opportunity - run querySelectorAll only on the
        // section that we know contains the comment
        var psdLinks = psdDom.querySelectorAll( selector );
        console.log("(",liveDupeLinkIdx, ")",selector, " --> ", psdLinks);

        function normalizeTextContent( tc ) {
            return deArmorFrenchSpaces( tc );
        }

        liveTextContent = normalizeTextContent( liveTextContent );

        // Narrow down by entire textContent of list element
        var psdCorrLinks = []; // the corresponding link elem(s)
        if( liveDupeLinkIdx === null ) {
            for( var i = 0; i < psdLinks.length; i++ ) {
                var psdContainer = ascendToCommentContainer( psdLinks[i], /* live */ false, true );
                //console.log("psdContainer",psdContainer);
                var psdTextContent = normalizeTextContent( surrTextContentFromElem( psdContainer[0] ) );
                //console.log(i,psdTextContent);
                if( psdTextContent === liveTextContent ) {
                    psdCorrLinks.push( psdLinks[i] );
                } /* else {
                    console.log(i,"len: psd live",psdTextContent.length,liveTextContent.length);
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
                //console.log(psdTextContent);
                if( psdTextContent === liveTextContent ) {
                    var psdDupeLinks = psdContainer.querySelectorAll( "a[href='" + newHref + "']" );
                    psdCorrLinks.push( psdDupeLinks[ liveDupeLinkIdx ] );
                }

                // Flag to ensure we don't take a link from this container again
                psdContainer.dataset.replyLinkGeCorrCo = true;
            }
        }

        if( psdCorrLinks.length === 0 ) {
            throw new Error( "Failed to find a matching comment in the Parsoid DOM." );
        } else if( psdCorrLinks.length > 1 ) {
            throw new Error( "Found multiple matching comments in the Parsoid DOM." );
        }

        return psdCorrLinks[0];
    }

    /**
     * Given the Parsoid output (GET /page/html endpoint) on the current
     * page and a DOM object in the current page corresponding to a
     * link in a signature, locate the section containing that
     * comment. That section may not be in the current page! Returns an
     * object with four properties:
     *
     *  - page: The full title of the page directly containing the
     *    comment (in its wikitext, not through transclusion).
     *  - sectionIdx: The anticipated wikitext section index containing
     *    the comment. That is, our best guess as to what the section
     *    index (in the wikitext, using ==wikitext headers==) will be,
     *    ignoring all of the wikitext headers that don't actually
     *    generate header elements (e.g. those inside nowikis, code
     *    blocks, etc).
     *  - sectionName: The anticipated wikitext section name. Should
     *    appear inside the equal signs at the above index.
     *  - sectionLevel: The anticipated wikitext section level (e.g.
     *    2 for an h2)
     *
     * Parsoid is abbreviated here as "psd" in variables and comments.
     */
    function findSection( psdDomString, sigLinkElem ) {

        console.log(psdDomString);

        var domParser = new DOMParser(),
            psdDom = domParser.parseFromString( psdDomString, "text/html" );

        var corrLink = getCorrCmt( psdDom, sigLinkElem );
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

        // Now, get the nearest header above us
        var currNode = corrCmt;
        var nearestHeader = null;
        var HTML_HEADER_RGX = /^h\d$/;
        do {
            if( HTML_HEADER_RGX.exec( currNode.tagName.toLowerCase() ) ) {
                nearestHeader = currNode;
                break;
            }
            var containedHeaders = currNode.querySelectorAll( HEADER_SELECTOR );
            if( containedHeaders.length ) {
                nearestHeader = containedHeaders[ containedHeaders.length - 1 ];
                break;
            }
            if( currNode.previousElementSibling ) {
                currNode = currNode.previousElementSibling;
                continue;
            }
            currNode = currNode.parentNode;
        } while( currNode.tagName.toLowerCase() !== "body" );

        // Get the target page (page actually containing the comment)
        var targetPage;
        if( tsclnId !== null ) {
            var tsclnInfoSel = "*[about='" + tsclnId + "'][typeof='mw:Transclusion']",
                infoJson = JSON.parse( psdDom.querySelector( tsclnInfoSel ) .dataset.mw );
            console.log(infoJson);
            for( var i = 0; i < infoJson.parts.length; i++ ) {
                if( infoJson.parts[i].template &&
                        infoJson.parts[i].template.target &&
                        infoJson.parts[i].template.target.wt &&
                        infoJson.parts[i].template.target.wt.indexOf( ":" ) >= 0 ) {
                    targetPage = infoJson.parts[i].template.target.wt;
                }
            }
        }
        if( targetPage && targetPage.charAt( 0 ) === "/" ) {

            // Given relative to the current page
            targetPage = currentPageName + targetPage;
        } else if( !targetPage ) {
            if( tsclnId !== null ) tsclnId = null;
            targetPage = currentPageName;
        }

        // Finally, get the index of our nearest header
        var headerIdx = iterableToList( psdDom.querySelectorAll( HEADER_SELECTOR ) )
                .filter( function ( header ) {
                    return ( header.getAttribute( "about" ) || null ) === tsclnId;
                } )
                .indexOf( nearestHeader );

        var result = {
            page: targetPage,
            sectionIdx: headerIdx,
            sectionName: nearestHeader.textContent,
            sectionLevel: nearestHeader.tagName.substring( 1 )
        };
        return result;
    }

    /**
     * Given some wikitext that's split into sections, return the full
     * wikitext (including header and newlines until the next header)
     * of the section with the given (zero-based) index. To get the content
     * before the first header, sectionIdx should be -1 and sectionName
     * should be null.
     *
     * Performs a sanity check with the given section name.
     */
    function getSectionWikitext( wikitext, sectionIdx, sectionName ) {
        var HEADER_RE = /^\s*==(=*)\s*(.+?)\s*\1==\s*$/gm;

        //console.log("In getSectionWikitext, sectionIdx = " + sectionIdx + ", sectionName = >" + sectionName + "<");
        //console.log("wikitext (first 1000 chars) is " + dirtyWikitext.substring(0, 1000));

        // There are certain locations where a header may appear in the
        // wikitext, but will not be present in the HTML; such as code
        // blocks or comments. So we keep track of those ranges
        // and ignore headings inside those.
        var ignoreSpanStarts = []; // list of ignored span beginnings
        var ignoreSpanLengths = []; // list of ignored span lengths
        var IGNORE_RE = /(<pre>[\s\S]+?<\/pre>)|(<!--[\s\S]+?-->)/g;
        var ignoreSpanMatch;
        do {
            ignoreSpanMatch = IGNORE_RE.exec( wikitext );
            if( ignoreSpanMatch ) {
                ignoreSpanStarts.push( ignoreSpanMatch.index );
                ignoreSpanLengths.push( ignoreSpanMatch[0].length );
            }
        } while( ignoreSpanMatch );

        var startIdx = -1; // wikitext index of section start
        var endIdx = -1; // wikitext index of section end

        var headerCounter = 0;
        var headerMatch;

        // The section before the first heading starts at idx 0
        if( sectionIdx === -1 ) {
            startIdx = 0;
        }

        // So that we don't check every ignore span every time
        var ignoreSpanStartIdx = 0;

        headerMatchLoop:
        do {
            headerMatch = HEADER_RE.exec( wikitext );
            if( headerMatch ) {

                // Check that we're not inside one of the "ignore" spans
                for( var igIdx = ignoreSpanStartIdx; igIdx <
                    ignoreSpanStarts.length; igIdx++ ) {
                    if( headerMatch.index > ignoreSpanStarts[igIdx] ) {
                        if ( headerMatch.index + headerMatch[0].length <=
                            ignoreSpanStarts[igIdx] + ignoreSpanLengths[igIdx] ) {

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
                if( headerCounter === sectionIdx ) {
                    var sanitizedWktxtSectionName = wikitextToTextContent( headerMatch[2] );

                    sectionName = deArmorFrenchSpaces( sectionName );

                    if( sanitizedWktxtSectionName !== sectionName ) {
                        throw new Error( "Sanity check on header name failed! Found \"" +
                                sanitizedWktxtSectionName + "\", expected \"" +
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

        if( startIdx < 0 ) {
            throw( "Could not find section named \"" + sectionName +
                    "\" at section idx " + sectionIdx );
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
        //console.log( "In sigIdxToStrIdx, sigIdx = " + sigIdx );

        // There are certain regions that we skip while attaching links:
        //
        //  - Spans with the class delsort-notice
        //  - Divs with the class xfd-relist
        //  - Templates that bury signatures in divs
        //    (e.g. resolution templates)
        //  - Some others
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
        var TEMPLATES_RE_TXT = /\{\{moved discussion (to|from)\|.+?\}\}/.source;
        var STRUCK_RE_TXT = /<s>.+?<\/s>/.source;
        var SKIP_REGION_RE = new RegExp("(" + DELSORT_SPAN_RE_TXT + ")|(" +
            XFD_RELIST_RE_TXT + ")|(" +
            STRUCK_RE_TXT + ")|(" +
            TEMPLATES_RE_TXT + ")", "ig");
        var skipRegionMatch;
        do {
            skipRegionMatch = SKIP_REGION_RE.exec( sectionWikitext );
            if( skipRegionMatch ) {
                spanStartIndices.push( skipRegionMatch.index );
                spanLengths.push( skipRegionMatch[0].length );
            }
        } while( skipRegionMatch );
        //console.log(spanStartIndices,spanLengths);

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
        var sigRgxSrc = "(?:" + /\[\[\s*:?\s*/.source + "(" + userspcLinkRgx.both +
                /([^\]]||\](?!\]))*?/.source + ")" + /\]\]\)?/.source + "(" +
                /[^\[]|\[(?!\[)|\[\[/.source + "(?!" + userspcLinkRgx.both +
                "))*?" + DATE_FMT_RGX[mw.config.get( "wgServer" )] +
                /\s+\(UTC\)|class\s*=\s*"autosigned".+?\(UTC\)<\/small>/.source +
                ")" + /(\S*([ \t\f]|<!--.*?-->)*(?:\{\{.+?\}\})?(?!\S)|\S+([ \t\f]|<!--.*?-->)*)$/.source;
        var sigRgx = new RegExp( sigRgxSrc, "igm" );
        var matchIdx = 0;
        var match;
        var matchIdxEnd;
        var dstSpnIdx;

        console.log(sectionWikitext);

        sigMatchLoop:
        for( ; true ; matchIdx++ ) {
            match = sigRgx.exec( sectionWikitext );
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
     * cmtAuthorDom is the username of the person who wrote the comment
     * we're replying to, parsed from the DOM. revObj is the object returned
     * by getWikitext for the page with the comment; findSectionResult is the
     * object returned by findSection for the comment.
     *
     * Returns a Deferred that resolves/rejects when the reply succeeds/fails.
     */
    function doReply( indentation, header, sigIdx, cmtAuthorDom, rplyToXfdNom, revObj, findSectionResult ) {
        console.log("TOP OF doReply",header,findSectionResult);
        header = [ "" + findSectionResult.sectionLevel, findSectionResult.sectionName, findSectionResult.sectionIdx ];
        var deferred = $.Deferred();

        // Change UI to make it clear we're performing an operation
        document.getElementById( "reply-dialog-field" ).style["background-image"] =
            "url(" + window.replyLinkPendingImageUrl + ")";
        document.querySelector( "#reply-link-buttons button" ).disabled = true;
        setStatus( "Loading..." );

        var wikitext = revObj.content;

        try {

            // Generate reply in wikitext form
            var reply = document.getElementById( "reply-dialog-field" ).value.trim();

            // Add a signature if one isn't already there
            if( !hasSig( reply ) ) {
                reply += " " + ( window.replyLinkSigPrefix ?
                    window.replyLinkSigPrefix : "" ) + LITERAL_SIGNATURE;
            }

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

            // Prepare section metadata for getSectionWikitext call
            //console.log( "in doReply, header =", header );
            var sectionHeader, sectionIdx;
            if( header === null ) {
                sectionHeader = null, sectionIdx = -1;
            } else {
                sectionHeader = header[1], sectionIdx = header[2];
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

            var sectionWikitext = getSectionWikitext( wikitext, sectionIdx, sectionHeader );
            var oldSectionWikitext = sectionWikitext; // We'll String.replace old w/ new

            // Now, obtain the index of the end of the comment
            var strIdx = sigIdxToStrIdx( sectionWikitext, sigIdx );

            // Check for a non-negative strIdx
            if( strIdx < 0 ) {
                throw( "Negative strIdx (signature not found in wikitext)" );
            }

            // Determine the user who wrote the comment, for
            // edit-summary and sanity-check purposes
            var userRgx = new RegExp( /\[\[\s*:?\s*/.source + userspcLinkRgx.both + /\s*(.+?)(?:\/.+?)?(?:#.+?)?\s*(?:\|.+?)?\]\]/.source, "g" );
            var userMatches = sectionWikitext.slice( 0, strIdx ).match( userRgx );
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
                    htmlDecode( cmtAuthorWktxt ) !== cmtAuthorDom &&
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
            var defaultSummmary = "Replying to " +
                ( rplyToXfdNom ? xfdType + " nomination by " : "" ) +
                cmtAuthorWktxt +
                ( markedEditReq ? " and marking edit request as answered" : "" );
            var customSummaryField = document.getElementById( "reply-link-summary" );
            var summaryCore = defaultSummmary;
            if( window.replyLinkCustomSummary && customSummaryField.value ) {
                summaryCore = customSummaryField.value.trim();
            }
            var summary = "/* " + sectionHeader + " */ " + summaryCore + ADVERT;

            // Send another request, this time to actually edit the
            // page
            api.postWithToken( "csrf", {
                action: "edit",
                title: mw.config.get( "wgPageName" ),
                summary: summary,
                text: newWikitext
            } ).done ( function ( data ) {

                // We put this function on the window object because we
                // give the user a "reload" link, and it'll trigger the function
                window.replyLinkReload = function () {
                    window.location.hash = sectionHeader.replace( / /g, "_" );
                    window.location.reload( true );
                };
                if ( data && data.edit && data.edit.result && data.edit.result == "Success" ) {

                    var reloadHtml = window.replyLinkAutoReload ? "automatically reloading"
                        : "<a href='javascript:window.replyLinkReload()' class='reply-link-reload'>Reload</a>";
                    setStatus( "Reply saved! (" + reloadHtml + ")" );

                    // Required to permit reload to happen, checked in onbeforeunload
                    replyWasSaved = true;

                    if( window.replyLinkAutoReload ) {
                        window.replyLinkReload();
                    }

                    deferred.resolve();
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
                console.log(data);
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
                    newLink.textContent = "cancel " + linkLabel;
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
                    " placeholder='Reply here!'></textarea>" +
                    ( window.replyLinkCustomSummary ? "<label for='reply-link-summary'>Summary: </label>" +
                        "<input id='reply-link-summary' class='mw-ui-input' placeholder='Edit summary' " +
                        "value='Replying to " + cmtAuthor + "'/><br />" : "" ) +
                    "<table style='border-collapse:collapse'><tr><td id='reply-link-buttons' style='width: " +
                    ( window.replyLinkPreloadPing === "button" ? "325" : "255" ) + "px'>" +
                    "<button id='reply-dialog-button' class='mw-ui-button mw-ui-progressive'>Reply</button> " +
                    "<button id='reply-link-preview-button' class='mw-ui-button'>Preview</button>" +
                    ( window.replyLinkPreloadPing === "button" ?
                        " <button id='reply-link-ping-button' class='mw-ui-button'>Ping</button>" : "" ) +
                    "<button id='reply-link-cancel-button' class='mw-ui-button mw-ui-quiet mw-ui-destructive'>Cancel</button></td>" +
                    "<td id='reply-dialog-status'></span><div style='clear:left'></td></tr></table>" +
                    "<div id='reply-link-options' class='gone-on-empty' style='margin-top: 0.5em'></div>" +
                    "<div id='reply-link-preview' class='gone-on-empty' style='border: thin dashed gray; padding: 0.5em; margin-top: 0.5em'></div>";
                mw.util.addCSS( ".gone-on-empty:empty { display: none; }" );
                parent.insertBefore( panelEl, newLinkWrapper.nextSibling );
                var replyDialogField = document.getElementById( "reply-dialog-field" );
                replyDialogField.style = "padding: 0.625em; min-height: 10em; margin-bottom: 0.75em;";
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
                if( EDIT_REQ_REGEX.test( ourMetadata[1][1] ) ) {
                    newOption( "reply-link-option-edit-req", "Mark edit request as answered?", false );
                }

                // If the previous comment was indented by OUTDENT_THRESH,
                // offer to outdent
                if( ourMetadata[0].length >= OUTDENT_THRESH ) {
                    newOption( "reply-link-option-outdent", "Outdent?", false );
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
                        var txt = "You've started a reply but haven't posted it";
                        e.returnValue = txt;
                        return txt;
                    }
                };

                // Called by the "Reply" button and Ctrl-Enter in the text area
                function startReply() {
                    var parsoidUrl = PARSOID_ENDPOINT + encodeURIComponent( currentPageName ),
                        findSectionResultPromise = $.get( parsoidUrl )
                            .then( function ( parsoidDomString ) {
                                return findSection( parsoidDomString, cmtLink );
                        },console.error );

                    var revObjPromise = findSectionResultPromise.then( function ( findSectionResult ) {
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
                        var sanitizedCode = document.getElementById( "reply-dialog-field" ).value
                                .replace( /&/g, "%26" );
                        $.post( "https:" + mw.config.get( "wgServer" ) +
                            "/api/rest_v1/transform/wikitext/to/html/" + encodeURIComponent( currentPageName ),
                            "wikitext=" + sanitizedCode + "&body_only=true",
                            function ( html ) {
                                document.getElementById( "reply-link-preview" ).innerHTML = html;

                                // The hrefs in the wikilinks are all given locally for some reason
                                var links = document.querySelectorAll( "#reply-link-preview a[rel='mw:WikiLink']" );
                                for( var i = 0, n = links.length; i < n; i++ ) {
                                    links[i].href = mw.util.getUrl( links[i].getAttribute("href").replace( /^\.\//, "" ) );
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
        var contentEls = mainContent.children;

        // Loop until we get a header
        var headerIndex = 0;
        for( headerIndex = 0; headerIndex < contentEls.length; headerIndex++ ) {
            if( contentEls[ headerIndex ].tagName.toLowerCase().startsWith( "h" ) ) break;
        }

        // If we didn't find any headers at all, that's a problem and we
        // should bail
        if( headerIndex === contentEls.length ) {
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
                node.className.indexOf( "localcomments" ) >= 0;

            var isSmall = node.nodeType === 1 && node.tagName.toLowerCase() === "small";

            // Small nodes are okay, unless they're delsort notices
            var isOkSmallNode = isSmall &&
                node.className.indexOf( "delsort-notice" ) < 0;

            if( ( node.nodeType === 3 ) ||
                    isOkSmallNode ||
                    isLocalCommentsSpan )  {

                // If the current node has a timestamp, attach a link to it
                // Also, no links after timestamps, because it's just like
                // having normal text afterwards, which is rejected (because
                // that means someone put a timestamp in the middle of a
                // paragraph)
                if( TIMESTAMP_REGEX.test( node.textContent ) &&
                        ( node.previousSibling || isSmall ) &&
                        ( !node.nextElementSibling ||
                            node.nextElementSibling.tagName.toLowerCase() !== "a" ) ) {
                    linkId = "reply-link-" + idNum;
                    attachLinkAfterNode( node, linkId, !!currIndentation );
                    idNum++;

                    // Update global metadata dictionary
                    metadata[linkId] = currIndentation;
                }
            } else if( /^(div|p|dl|dd|ul|li|span|ol)$/.test( node.tagName.toLowerCase() ) ) {
                switch( node.tagName.toLowerCase() ) {
                case "dl": newIndentSymbol = ":"; break;
                case "ul": newIndentSymbol = "*"; break;
                case "ol": newIndentSymbol = "#"; break;
                case "div":
                    if( node.className !== "hover-edit-section" ) {
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
                    currHeaderEl.childNodes[0].className.indexOf( "mw-headline" ) >= 0 ) {
                    headlineEl = currHeaderEl.childNodes[0];
                } else {
                    for( var i = 0; i < currHeaderEl.childNodes.length; i++ ) {
                        if( currHeaderEl.childNodes[i].className &&
                                currHeaderEl.childNodes[i].className
                                .indexOf( "mw-headline" ) >= 0 ) {
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
                    var findSectionResult = findSection( parsoidDomString, cmtLink );

                    getWikitext( findSectionResult.page, /* useCaching */ true ).then( function ( revObj ) {
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

        // Exit if history page or edit page
        if( mw.config.get( "wgAction" ) === "history" ) return;
        if( document.getElementById( "editform" ) ) return;

        api = new mw.Api();

        mw.util.addCSS(
            "#reply-link-panel { padding: 1em; margin-left: 1.6em; "+
              "max-width: 1200px; width: 66%; margin-top: 0.5em; }"
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

        // Default value for some preferences
        if( window.replyLinkAutoReload === undefined ) {
            window.replyLinkAutoReload = true;
        }

        if( window.replyLinkDryRun === undefined ) {
            window.replyLinkDryRun = "never";
        }

        if( window.replyLinkPreloadPing === undefined ) {
            window.replyLinkPreloadPing = "always";
        }

        if( window.replyLinkPreloadPingTpl === undefined ) {
            window.replyLinkPreloadPingTpl = "{{u|##}}, ";
        }

        if( window.replyLinkCustomSummary === undefined ) {
            window.replyLinkCustomSummary = false;
        }

        if( window.replyLinkTestMode === undefined ) {
            window.replyLinkTestMode = false;
        }

        // Insert "reply" links into DOM
        attachLinks();

        // If test mode is enabled, create a link for that
        if( window.replyLinkTestMode ) {
            mw.util.addPortletLink( "p-cactions", "#", "reply-link test mode", "pt-reply-link-test" )
                .addEventListener( "click", runTestMode );
        }

        // This large string creats the "pending" texture
        window.replyLinkPendingImageUrl = "data:image/gif;base64,R0lGODlhGAAYAKIGAP7+/vv7+/Ly8u/v7+7u7v///////wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFAAAGACwAAAAAGAAYAAADU0hKAvUwvjCWbTIXahfWEdcxDgiJ3Wdu1UiUK5quUzuqoHzBuZ3yGp0HmBEqcEHfjmYkMZXDp8sZgx6JkiayaKWatFhJd1uckrPWcygdXrvUJ1sCACH5BAUAAAYALAAAAAAYABgAAANTSLokUDBKGAZbbupSr8qb1HlgSFnkY55eo67jVZoxM4c189IoubKtmyaH2W2IH+OwJ1NOkK4fVPhk2pwia1GqTXJbUVg3zANTs2asZHwWpX+cQQIAIfkEBQAABgAsAAAAABgAGAAAA1E4tLwCJcoZQ2uP6hLUJdk2dR8IiRL5hSjnXSyqwmc7Y7X84m21MzHRrZET/oA9V8nUGwKLGqcDSpEybcdpM3vVLYNRLrgqpo7K2685hcaqkwkAIfkEBQAABgAsAAAAABgAGAAAA1RYFUP+TgBFq2IQSstxjhNnNR+xiVVQmiF6kdnpLrDWul58o7k9vyUZrvYQ8oigHy24E/UgzQ4yonwWo6kp62dNzrrbr9YoXZEt4HPWjKWk20CmKwEAIfkEBQAABgAsAAAAABgAGAAAA1NYWjH08Amwam0xTstxlhR3OR+xiYv3nahCrmHLlGbcqpqN4hB7vzmZggcSMoA9nYhYMzJ9O2RRyCQoO1KJM9uUVaFYGtjyvY7E5hR3fC6x1WhRAgAh+QQFAAAGACwAAAAAGAAYAAADVFi6FUMwQgGYVU5Kem3WU9UtH8iN2AMSJ1pq7fhuoquaNXrDubyyvc4shCLtIjHZkVhsLIFN5yopfFIvQ2gze/U8CUHsVxDNam2/rjEdZpjVKTYjAQAh+QQFAAAGACwAAAAAGAAYAAADU1i6G0MwQgGYVU5Kem3WU9U1D0hwI1aCaPqxortq7fjSsT1veXfzqcUuUrOZTj3fEBlUmYrKZ/LyCzULVWYzC6Uuu57vNHwcM7KnKxpMOrKdUkUCACH5BAUAAAYALAAAAAAYABgAAANTWLqsMSTKKEC7b856W9aU1S0fyI0OBBInWmrt+G6iq5q1fMN5N0sx346GSq1YPcwQmLwsQ0XHMShcUZXWpud53WajhR8SLO4yytozN016EthGawIAIfkEBQAABgAsAAAAABgAGAAAA1MoUNzOYZBJ53o41ipwltukeI4WEiMJgWGqmu31sptLwrV805zu4T3V6oTyfYi2H4+SPJ6aDyDTiFmKqFEktmSFRrvbhrQoHMbKhbGX+wybc+hxAgAh+QQFAAAGACwAAAAAGAAYAAADVEgqUP7QhaHqajFPW1nWFEd4H7SJBFZKoSisz+mqpcyRq23hdXvTH10HCEKNiBHhBVZQHplOXtC3Q5qoQyh2CYtaIdsn1CidosrFGbO5RSfb35gvAQAh+QQFAAAGACwAAAAAGAAYAAADU0iqAvUwvjCWbTIXahfWEdcRHzhVY2mKnQqynWOeIzPTtZvBl7yiKd8L2BJqeB7jjti7IRlKyZMUDTGTzis0W6Nyc1XIVJfRep1dslSrtoJvG1QCACH5BAUAAAYALAAAAAAYABgAAANSSLoqUDBKGAZbbupSb3ub1HlZGI1XaXIWCa4oo5ox9tJteof1sm+9xoqS0w2DhBmwKPtNkEoN1Cli2o7WD9ajhWWT1NM3+hyHiVzwlkuemIecBAAh+QQFAAAGACwAAAAAGAAYAAADUxhD3CygyEnlcg3WXQLOEUcpH6GJE/mdaHdhLKrCYTs7sXiDrbQ/NdkLF9QNHUXO79FzlUzJyhLam+Y21ujoyLNxgdUv1fu8SsXmbVmbQrN97l4CACH5BAUAAAYALAAAAAAYABgAAANSWBpD/k4ARetq8EnLWdYTV3kfsYkV9p3oUpphW5AZ29KQjeKgfJU6ES8Su6lyxd2x5xvCfLPlIymURqDOpywbtHCpXqvW+OqOxGbKt4kGn8vuBAAh+QQFAAAGACwAAAAAGAAYAAADU1iqMfTwCbBqbTFOy3GWFHc5H7GJi/edaKFmbEuuYeuWZt2+UIzyIBtjptH9iD2jCJgTupBBIdO3hDalVoKykxU4mddddzvCUS3gc7mkTo2xZmUCACH5BAUAAAYALAAAAAAYABgAAANTWLoaQzBCAZhtT0Z6rdNb1S0fSHAjZp5iWoKom8Ht+GqxPeP1uEs52yrYuYVSpN+kV1SykCoatGBcTqtPKJZ42TK7TsLXExZcy+PkMB2VIrHZQgIAIfkEBQAABgAsAAAAABgAGAAAA1RYuhxDMEIBmFVOSnpt1lPVLR/IjdgDEidaau34bqKrmrV8w3k3RzHfjoZaDIE934qVvPyYxdQqKJw2PUdo9El1ZrtYa7TAvTayBDMJLRg/tbYlJwEAIfkEBQAABgAsAAAAABgAGAAAA1IItdwbg8gphbsFUioUZtpWeV8WiURXPqeorqFLfvH2ljU3Y/l00y3b7tIbrUyo1NBRVB6bv09Qd8wko7yp8al1clFYYjfMHC/L4HOjSF6bq80EACH5BAUAAAYALAAAAAAYABgAAANTSALV/i0MQqtiMEtrcX4bRwkfFIpL6Zxcqhas5apxNZf16OGTeL2wHmr3yf1exltR2CJqmDKnCWqTgqg6YAF7RPq6NKxy6Rs/y9YrWpszT9fAWgIAOw==";

    }

    mw.loader.load( "mediawiki.ui.input", "text/css" );
    mw.loader.using( [ "mediawiki.util", "mediawiki.api" ] ).then( function () {
        mw.hook( "wikipage.content" ).add( onReady );
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

    if ( normalView && ( currNamespace % 2 === 1 || currNamespace === 4 || ttdykPage ) ) {
        loadReplyLink( jQuery, mediaWiki );
    }
}
//</nowiki>
