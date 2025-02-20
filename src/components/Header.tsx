import React from 'react';
import { Box, Container, Typography, AppBar } from '@mui/material';
import './header.css';


const Header: React.FC = () => {
  return (
    <AppBar position="fixed" sx={{ bgcolor: 'background.paper' }}>
      <Container maxWidth="lg" sx={{ ml: 0 }}>
        <Box sx={{ py: 2 }}>
          <Typography variant="h4" component="h1" color="text.primary">
            LLM Response Comparison
          </Typography>
        </Box>
      </Container>
    </AppBar>
  );
};

export default Header;
