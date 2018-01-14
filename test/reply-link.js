var expect = require( "must" );
var rewire = require( "rewire" );
var promise = require( "promise" );
var fs = require( "fs" );
var path = require( "path" );

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

describe( "wikitextToTextContent", function () {
    it( "doesn't touch normal text", function () {
        var sampleNormalText = "asdf!@#$%^&*()";
        expect( replyLink.wikitextToTextContent( sampleNormalText ) ).to.equal( sampleNormalText );
    } );

    it( "strips wikilinks", function () {
        var sampleLink = "[[A#B|C]]";
        expect( replyLink.wikitextToTextContent( sampleLink ) ).to.equal( "C" );
    } );
} );

describe( "insertTextAfterIdx", function () {

    // Utilty function for testing
    function doTest( sectionWikitext, sigIdx, reply, indentLvl, sectionWikitextWithReply ) {
        var strIdx = replyLink.sigIdxToStrIdx( sectionWikitext, sigIdx );
        var newSectionWikitext = replyLink.insertTextAfterIdx( sectionWikitext,
                strIdx, indentLvl, reply );
        var success = newSectionWikitext === sectionWikitextWithReply;
        if( !success ) {
            console.log( "GOT: |>" + newSectionWikitext + "<|" );
            //console.log( "EXPECTED: |>" + sectionWikitextWithReply + "<|" );
        }
        expect( success ).to.be.true();
    }
    it( "should insert in a one-comment section", function () {
        doTest( "==Foo==\nHi! " + SIG1 + "\n", 0, ":r ~~~~", 0,
                "==Foo==\nHi! " + SIG1 + "\n:r ~~~~\n" );
    } );

    it( "should insert in a two-comment section", function () {
        var sectionWikitext = "==Foo==\nA " + SIG1 + "\n:B " + SIG2 + "\n\n";
        doTest( sectionWikitext, 1, "::r ~~~~", 1,
                sectionWikitext.trim() + "\n::r ~~~~\n\n" );
    } );

    it( "should reply to the first comment in a two-comment section", function () {
        var sw = "==Foo==\nA " + SIG1 + "\n:B " + SIG2 + "\n\n";
        var reply = ":r ~~~~";
        var res = "==Foo==\nA " + SIG1 + "\n:B " + SIG2 + "\n:r ~~~~\n\n";
        doTest( sw, 0, reply, 0, res );
    } );

    describe( "should insert in a two-comment section with blank lines", function () {
        it( "around the comments", function () {
            var sectionWikitext = "==Foo==\n\nA " + SIG1 + "\n:B " + SIG2 + "\n\n";
            var reply = "::r ~~~~";
            var result = "==Foo==\n\nA " + SIG1 + "\n:B " + SIG2 + "\n" + reply + "\n\n";
            doTest( sectionWikitext, 1, reply, 1, result );
        } );

        it( "around the comments and one in between", function () {
            var sectionWikitext = "==Foo==\n\nA " + SIG1 + "\n\n:B " + SIG2 + "\n\n";
            var reply = "::r ~~~~";
            var result = "==Foo==\n\nA " + SIG1 + "\n\n:B " + SIG2 + "\n" + reply + "\n\n";
            doTest( sectionWikitext, 1, reply, 1, result );
        } );
    } );

    describe( "should work fine with the tq template", function () {
        it( "around the comment being replied to", function () {
            var sw = "==Foo==\n{{tq|A " + SIG1 + "}}\n\n";
            var reply = ":r ~~~~";
            var result = "==Foo==\n{{tq|A " + SIG1 + "}}\n:r ~~~~\n\n";
            doTest( sw, 0, reply, 0, result );
        } );

        it( "around the comment being replied to, with an existing one", function () {
            var sw = "==Foo==\n{{tq|A " + SIG1 + "}}\n:B " + SIG2 + "\n\n";
            var reply = ":r ~~~~";
            var result = "==Foo==\n{{tq|A " + SIG1 + "}}\n:B " + SIG2 + "\n:r ~~~~\n\n";
            doTest( sw, 0, reply, 0, result );
        } );
    } );

    describe( "should work in real-life cases", function () {
        var testData = fs.readFileSync( path.join( __dirname, "test-data.txt" ), { "encoding": "utf-8" } );
        var testDataSegments = testData.split( "~~~~~~~~~~\n" );
        it( "#1", function () {
            var sectionWikitext = testDataSegments[0];
            var reply = "::::r ~~~~";
            var result = testDataSegments[1];
            doTest( sectionWikitext, 3, reply, 3, result );
        } );

        it( "#2", function () {
            var sw = testDataSegments[2];
            var reply = ":::r ~~~~";
            var res = testDataSegments[3];
            doTest( sw, 11, reply, 2, res );
        } );

        it( "#3", function () {
            var sw = testDataSegments[4].replace( "\n:::r ~~~~", "" );
            var reply = ":::r ~~~~";
            var res = testDataSegments[4];
            doTest( sw, 43, reply, 2, res );
        } );
    } );
} );
