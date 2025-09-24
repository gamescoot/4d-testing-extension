// UserServiceTest.4dm
Class constructor()
	
	// #tags: unit, fast
Function test_user_creation($t : cs.Testing)
	var $user : Object
	$user:=New object("name"; "John"; "email"; "john@example.com")
	
	$t.assert.isNotNull($t; $user.name; "User should have a name")
	$t.assert.areEqual($t; "John"; $user.name; "User name should be correct")