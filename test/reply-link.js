var expect = require( "must" );
var rewire = require( "rewire" );
var promise = require( "promise" );

// Use reWIRE to import the loader
var replyLinkLoader = rewire( "../reply-link.js" );

replyLinkLoader.__set__( "document", {
    "getElementById": function ( id ) { return {}; }
} );

// Create our fake modules for patching in
var fakeJQuery = { };

var fakeMW = {
    "config": {
        "get": function () { return 3; } // User talk
    },
    "loader": {
        "load": function( x, y ) {},
        "using": function( x ) {
            return new Promise( function( resolve ) { resolve(); } );
        }
    },
    "hook": function( x ) {
        return { "add": function( f ) { f(); } }
    }
};

var replyLink = replyLinkLoader.loadReplyLink( fakeJQuery, fakeMW );

// Constants for testing
var SIG1 = "[[User:X|X]] ([[User talk:X|talk]]) 00:29, 4 May 2017 (UTC)";
var SIG2 = "[[User:Y|Y]] ([[User talk:Y|talk]]) 00:31, 4 May 2017 (UTC)";

// Actual test cases begin here
describe( "iterableToList", function () {
    it( "should work on the empty list", function () {
        expect( replyLink.iterableToList( [] ) ).to.eql( [] );
    } );

    it( "should work on a list with one element", function () {
        expect( replyLink.iterableToList( [1] ) ).to.eql( [1] );
    } );
} );

describe( "insertTextAfterIdx", function () {

    // Utilty function for testing
    function doTest( sectionWikitext, sigIdx, reply, indentLvl, sectionWikitextWithReply ) {
        var strIdx = replyLink.sigIdxToStrIdx( sectionWikitext, sigIdx );
        var newSectionWikitext = replyLink.insertTextAfterIdx( sectionWikitext,
                strIdx, indentLvl, reply );
        console.log( "|>" + newSectionWikitext + "<|" );
        expect( newSectionWikitext === sectionWikitextWithReply ).to.be.true();
    }
    it( "should pass a basic test", function () {
        doTest( "==Foo==\nHi! " + SIG1 + "\n", 0, ":r ~~~~", 0,
                "==Foo==\nHi! " + SIG1 + "\n:r ~~~~\n" );
    } );

    it( "should pass another basic test", function () {
        var sectionWikitext = "==Foo==\nA " + SIG1 + "\n:B " + SIG2 + "\n\n";
        doTest( sectionWikitext, 1, "::r ~~~~", 1,
                sectionWikitext.trim() + "\n::r ~~~~\n\n" );
    } );
} );
