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

// Actual test cases begin here
describe( "iterableToList", function () {
    it( "should work on the empty list", function () {
        expect( replyLink.iterableToList( [] ) ).to.eql( [] );
    } );

    it( "should work on a list with one element", function () {
        expect( replyLink.iterableToList( [1] ) ).to.eql( [1] );
    } );
} );
