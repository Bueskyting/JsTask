<?php
// Opening /productPage/ without a game id sends the visitor back to the home page
header("Location: ../index.html");
exit();
